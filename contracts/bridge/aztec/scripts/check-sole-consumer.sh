#!/usr/bin/env bash
# Sole-consumer invariant: the hub consumes L1→L2 messages at exactly two sites, `_bind` (the
# factory's `register` message) and `claim_from_pool` (a pool withdrawal's bridge message), and no
# path dependency consumes at all. `claim_from_pool` must take the recipient from its caller and
# rebuild both the content and the secret from its own arguments, so a claim is never a bearer
# instrument: a stray consume, a raw secret, a recipient or portal from a parameter, or a content or
# commitment built any other way would let a party holding a deposit's data redirect or forge it.
#
# A static tripwire: the TXE cases prove the semantics; this pins the dataflow they rely on. Sources
# are scanned with comments removed and string literals emptied, then flattened to one line so a
# multi-line signature or body matches one regex. Every source counts, tests included: Noir compiles
# a crate's test module with it. `--self-test` replays crafted regressions, each of which must fail
# with its own reason.
#
# Usage: check-sole-consumer.sh [--self-test | <hub crate dir>]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Removes comments (nested block comments included, as Noir nests them) and empties string literals,
# in one string-aware pass, so neither a comment nor a string can hide or fake live code.
clean() {
	perl -0777 -ne '
		my ($s, $o, $i, $d) = ($_, "", 0, 0);
		my $n = length $s;
		while ($i < $n) {
			my $two = substr($s, $i, 2);
			if ($d > 0) {
				if ($two eq "/*") { $d++; $i += 2 } elsif ($two eq "*/") { $d--; $i += 2; $o .= " " if !$d } else { $i++ }
				next;
			}
			if ($two eq "/*") { $d = 1; $i += 2; next }
			if ($two eq "//") { my $j = index($s, "\n", $i); $i = $j < 0 ? $n : $j; next }
			if (substr($s, $i, 1) eq "\"") {
				my $j = $i + 1;
				while ($j < $n && substr($s, $j, 1) ne "\"") { $j += substr($s, $j, 1) eq "\\" ? 2 : 1 }
				$o .= "\"\""; $i = $j + 1; next;
			}
			$o .= substr($s, $i, 1); $i++;
		}
		print $o;
	' | tr '\n\t' '  ' | tr -s ' '
}

violation() {
	echo "SOLE-CONSUMER VIOLATION: $*" >&2
	return 1
}

# Occurrences (not lines) of the ERE $1 in $2.
count() {
	local n
	n=$(printf '%s' "$2" | grep -oE -- "$1" | wc -l) || true
	echo $((n))
}

# Every source of the crate at $1, cleaned and flattened.
crate_source() {
	find "$1/src" -name '*.nr' -print0 | sort -z | xargs -0 cat | clean
}

# The transitive path dependencies of the crate at $1, one directory per line.
path_deps() {
	local -a queue=("$1")
	local seen=" $1 " dir rel dep
	while [ "${#queue[@]}" -gt 0 ]; do
		dir="${queue[0]}"
		queue=("${queue[@]:1}")
		while IFS= read -r rel; do
			dep="$(cd "$dir/$rel" 2>/dev/null && pwd)" || { echo "SOLE-CONSUMER: unresolvable path dependency $rel of $dir" >&2; return 1; }
			case "$seen" in *" $dep "*) continue ;; esac
			seen="$seen$dep "
			queue+=("$dep")
			printf '%s\n' "$dep"
		done < <(sed -nE 's/.*path[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$dir/Nargo.toml")
	done
}

# The body of the one function named $1 in $2 (signature included, up to the next `fn`).
fn_body() {
	printf '%s' "$2" | sed -E "s/.*fn $1[[:space:]]*\(/(/; s/ fn .*//"
}

# Every name a `let` binds in $1 (tuple patterns included, type annotations dropped).
bound_names() {
	printf '%s' "$1" | perl -ne '
		while (/\blet\s+(.*?)\s*=(?!=)/g) {
			my $l = $1; $l =~ s/:[^,)]*//g;
			while ($l =~ /\b([a-z_][a-z0-9_]*)\b/g) { print "$1\n" unless $1 eq "mut" }
		}'
}

# The name bound by the single `let NAME = $2;` in $1; fails unless there is exactly one.
bind_once() {
	local hits
	hits=$(printf '%s' "$1" | grep -oE -- "let [a-z][a-z0-9_]* = $2;") || true
	[ -n "$hits" ] && [ "$(printf '%s\n' "$hits" | wc -l)" -eq 1 ] || return 1
	printf '%s' "$hits" | sed -E 's/^let ([a-z][a-z0-9_]*) = .*/\1/'
}

# Fails with $3 if any name in $2 is bound more than once (or, with $4 = 0, at all) in $1.
assert_bound() {
	local body="$1" names="$2" fn="$3" want="${4:-1}" name n all
	all=$(bound_names "$body")
	for name in $names; do
		n=$(printf '%s\n' "$all" | grep -cxF -- "$name") || true
		[ "$n" -le "$want" ] || { violation "$fn rebinds $name"; return 1; }
	done
}

check_bind() {
	local src="$1" body
	[ "$(count 'fn _bind ?\(' "$src")" -eq 1 ] || { violation "no single _bind function"; return 1; }
	body=$(fn_body _bind "$src")
	# The sender is the storage-bound factory, read in this body, not a parameter of that name.
	printf '%s' "$body" | grep -qF "let l1_factory = self.storage.l1_factory.read();" ||
		{ violation "_bind does not read l1_factory from storage"; return 1; }
	printf '%s' "$body" | grep -qF "let secret = if publish { REGISTER_SECRET } else { BIND_HARNESS_SECRET };" ||
		{ violation "_bind does not pick its secret from the two constants by the publish flag"; return 1; }
	assert_bound "$body" "l1_factory secret" _bind || return 1
	printf '%s' "$body" | grep -qE "consume_l1_to_l2_message\([a-z_]+, \[secret\], l1_factory, register_leaf_index\)" ||
		{ violation "_bind does not consume [secret] from l1_factory"; return 1; }
}

# The recipient is the caller; the portal is the claimed token's; the commitment, secret and
# content are rebuilt from the arguments; the consume and the mint use exactly those values.
check_claim() {
	local src="$1" body params r p k s c
	[ "$(count 'fn claim_from_pool ?\(' "$src")" -eq 1 ] || { violation "no single claim_from_pool function"; return 1; }
	body=$(fn_body claim_from_pool "$src")
	params=$(printf '%s' "$body" | sed -E 's/\).*//')
	printf '%s' "$params" | grep -qE '\bclaim_salt:' || { violation "claim_from_pool does not take claim_salt"; return 1; }
	! printf '%s' "$params" | grep -qi secret || { violation "claim_from_pool takes a secret parameter"; return 1; }

	r=$(bind_once "$body" 'self\.msg_sender\(\)') ||
		{ violation "claim_from_pool does not bind the recipient once to self.msg_sender()"; return 1; }
	p=$(bind_once "$body" 'self\.storage\.portal_of\.at\(token\)\.read\(\)') ||
		{ violation "claim_from_pool does not read the portal once from portal_of.at(token)"; return 1; }
	k=$(bind_once "$body" 'hash_2\(\[change_precommitment, label\]\)') ||
		{ violation "claim_from_pool does not compute the commitment once as hash_2([change_precommitment, label])"; return 1; }
	s=$(bind_once "$body" "derive_claim_secret\(claim_salt, $r\)") ||
		{ violation "claim_from_pool does not derive the secret once from (claim_salt, recipient)"; return 1; }
	c=$(bind_once "$body" "bridge_content_v1\(nullifier, $k, amount\)") ||
		{ violation "claim_from_pool does not build the content once with bridge_content_v1(nullifier, commitment, amount)"; return 1; }

	local args
	args=$(printf '%s' "$params" | grep -oE '[a-z_][a-z0-9_]*:' | tr -d ':' | tr '\n' ' ')
	assert_bound "$body" "$r $p $k $s $c" claim_from_pool || return 1
	assert_bound "$body" "$args" claim_from_pool 0 || return 1

	[ "$(count 'consume_l1_to_l2_message\(' "$body")" -eq 1 ] &&
		printf '%s' "$body" | grep -qE "consume_l1_to_l2_message\($c, \[$s\], $p, message_leaf_index\)" ||
		{ violation "claim_from_pool does not consume (content, [secret], portal, message_leaf_index)"; return 1; }
	printf '%s' "$body" | grep -qE "self\.call\(LabelledToken::at\(token\)\.mint_from_bridge\($r, amount, label\)\);" ||
		{ violation "claim_from_pool does not mint with self.call(LabelledToken::at(token).mint_from_bridge(recipient, amount, label))"; return 1; }
}

# Returns 0 if the hub crate at $1 upholds the invariant, 1 with one reason on stderr otherwise.
check_crate() {
	local crate="$1" src deps dep n
	[ -f "$crate/src/main.nr" ] || { echo "SOLE-CONSUMER: no such crate: $crate" >&2; return 1; }
	src=$(crate_source "$crate")
	deps=$(path_deps "$crate") || return 1

	n=$(count 'consume_l1_to_l2_message' "$src")
	[ "$n" -eq 2 ] || { violation "expected 2 consume_l1_to_l2_message sites in the hub, found $n"; return 1; }
	local all="$src"
	while IFS= read -r dep; do
		[ -n "$dep" ] || continue
		local dsrc
		dsrc=$(crate_source "$dep")
		[ "$(count 'consume_l1_to_l2_message' "$dsrc")" -eq 0 ] ||
			{ violation "a path dependency consumes an L1 to L2 message: $(basename "$dep")"; return 1; }
		all="$all $dsrc"
	done <<<"$deps"
	# These consume or nullify a message without consume_l1_to_l2_message.
	[ "$(count 'process_l1_to_l2_message|push_nullifier' "$all")" -eq 0 ] ||
		{ violation "a lower-level messaging or nullifier primitive is present"; return 1; }
	n=$(count 'mint_from_bridge[[:space:]]*\(' "$src")
	[ "$n" -eq 1 ] || { violation "expected 1 mint_from_bridge call in the hub, found $n"; return 1; }

	check_bind "$src" || return 1
	check_claim "$src" || return 1
}

# ── Self-test ────────────────────────────────────────────────────────────────────────────────────

# A minimal hub in the real one's shape. Every regression below is this source with one mutation.
CONTROL='use claim_secret_lib::derive_claim_secret;
contract Hub {
    #[internal("private")]
    fn _bind(erc20: EthAddress, portal: EthAddress, register_leaf_index: Field, publish: bool) -> AztecAddress {
        let l1_factory = self.storage.l1_factory.read();
        let content = get_register_content_hash(erc20, portal);
        let secret = if publish { REGISTER_SECRET } else { BIND_HARNESS_SECRET };
        self.context.consume_l1_to_l2_message(content, [secret], l1_factory, register_leaf_index);
        token
    }

    #[external("private")]
    fn claim_from_pool(
        token: AztecAddress,
        amount: u128,
        nullifier: Field,
        change_precommitment: Field,
        label: Field,
        claim_salt: Field,
        message_leaf_index: Field,
    ) {
        let recipient = self.msg_sender();
        assert(label != 0, "claim label is zero");
        let portal = self.storage.portal_of.at(token).read();
        let commitment = hash_2([change_precommitment, label]);
        let secret = derive_claim_secret(claim_salt, recipient);
        let content = bridge_content_v1(nullifier, commitment, amount);
        self.context.consume_l1_to_l2_message(content, [secret], portal, message_leaf_index);
        self.call(LabelledToken::at(token).mint_from_bridge(recipient, amount, label));
    }

    #[external("public")]
    fn token_for(erc20: EthAddress) -> AztecAddress {
        self.storage.token_of.at(erc20).read()
    }
}
'

# Writes fixture $1 as CONTROL with the perl substitution $2 applied (which must change it).
fixture() {
	local dir="$tmp/$1/hub" base out
	mkdir -p "$dir/src"
	printf '[package]\nname = "hub"\ntype = "contract"\n[dependencies]\n' >"$dir/Nargo.toml"
	base=$(printf '%s' "$CONTROL")
	out=$(printf '%s' "$CONTROL" | perl -0777 -pe "$2")
	[ "$out" != "$base" ] || { echo "SELF-TEST FAIL: fixture $1 does not mutate the control" >&2; fails=$((fails + 1)); }
	printf '%s' "$out" >"$dir/src/main.nr"
}

# Fixture $1 must be rejected with exactly the reason $2.
expect() {
	local got
	if got=$(check_crate "$tmp/$1/hub" 2>&1 >/dev/null); then
		echo "SELF-TEST FAIL: $1 accepted" >&2
		fails=$((fails + 1))
	elif [ "$got" != "SOLE-CONSUMER VIOLATION: $2" ]; then
		echo "SELF-TEST FAIL: $1 rejected for another reason: '$got' (expected '$2')" >&2
		fails=$((fails + 1))
	else
		rejected=$((rejected + 1))
	fi
}

self_test() {
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	fails=0
	rejected=0

	check_crate "$here/token_bridge_hub" >/dev/null 2>&1 || { echo "SELF-TEST FAIL: the real hub is rejected" >&2; fails=$((fails + 1)); }
	fixture control 's/(\n}\n)$/\n$1/'
	check_crate "$tmp/control/hub" >/dev/null 2>&1 || { echo "SELF-TEST FAIL: the control is rejected" >&2; fails=$((fails + 1)); }

	# Counts and banned primitives.
	fixture stray_consume 's/(\n}\n)$/\n    fn claim_bearer(raw: Field, leaf: Field) { self.context.consume_l1_to_l2_message(raw, [raw], portal, leaf); }$1/'
	expect stray_consume "expected 2 consume_l1_to_l2_message sites in the hub, found 3"
	fixture one_line 's/(self\.context\.consume_l1_to_l2_message\(content, \[secret\], portal, message_leaf_index\);)/$1 $1/'
	expect one_line "expected 2 consume_l1_to_l2_message sites in the hub, found 3"
	fixture dep_consume 's/(\n}\n)$/\n$1/'
	printf 'evil = { path = "../evil" }\n' >>"$tmp/dep_consume/hub/Nargo.toml"
	mkdir -p "$tmp/dep_consume/evil/src"
	printf '[package]\nname = "evil"\ntype = "lib"\n' >"$tmp/dep_consume/evil/Nargo.toml"
	printf 'pub fn take(context: &mut PrivateContext, c: Field, s: Field, p: EthAddress, i: Field) {\n    context.consume_l1_to_l2_message(c, [s], p, i);\n}\n' >"$tmp/dep_consume/evil/src/lib.nr"
	expect dep_consume "a path dependency consumes an L1 to L2 message: evil"
	fixture lowlevel 's/(\n}\n)$/\n    fn claim_bearer(raw: Field, leaf: Field) {\n        let m = self.context.process_l1_to_l2_message(raw, leaf);\n        self.context.push_nullifier(m);\n    }$1/'
	expect lowlevel "a lower-level messaging or nullifier primitive is present"
	fixture string_slash 's/(        let portal =)/        let url = "https:\/\/x"; let m = self.context.process_l1_to_l2_message(claim_salt, message_leaf_index);\n$1/'
	expect string_slash "a lower-level messaging or nullifier primitive is present"
	fixture string_block 's/(        let portal =)/        let open = "\/*";\n        let m = self.context.process_l1_to_l2_message(claim_salt, message_leaf_index);\n        let close = "*\/";\n$1/'
	expect string_block "a lower-level messaging or nullifier primitive is present"
	fixture second_mint 's/(\n}\n)$/\n    fn mint_more(token: AztecAddress, to: AztecAddress, amount: u128, label: Field) {\n        self.call(LabelledToken::at(token).mint_from_bridge(to, amount, label));\n    }$1/'
	expect second_mint "expected 1 mint_from_bridge call in the hub, found 2"
	fixture spaced_mint 's/(\n}\n)$/\n    fn mint_more(token: AztecAddress, to: AztecAddress, amount: u128, label: Field) {\n        self.call(LabelledToken::at(token).mint_from_bridge (to, amount, label));\n    }$1/'
	expect spaced_mint "expected 1 mint_from_bridge call in the hub, found 2"

	# _bind.
	fixture bind_renamed 's/fn _bind\(/fn _attach(/'
	expect bind_renamed "no single _bind function"
	fixture bind_param_factory 's/        let l1_factory = self\.storage\.l1_factory\.read\(\);\n//; s/(fn _bind\(erc20: EthAddress,)/$1 l1_factory: EthAddress,/'
	expect bind_param_factory "_bind does not read l1_factory from storage"
	fixture bind_block_comment 's/(        )(let l1_factory = self\.storage\.l1_factory\.read\(\);)/$1\/* $2 *\//; s/(fn _bind\(erc20: EthAddress,)/$1 l1_factory: EthAddress,/'
	expect bind_block_comment "_bind does not read l1_factory from storage"
	fixture bind_caller_secret 's/        let secret = if publish \{ REGISTER_SECRET \} else \{ BIND_HARNESS_SECRET \};\n//; s/(fn _bind\(erc20: EthAddress,)/$1 secret: Field,/'
	expect bind_caller_secret "_bind does not pick its secret from the two constants by the publish flag"
	fixture bind_factory_shadowed 's/(let l1_factory = self\.storage\.l1_factory\.read\(\);\n)/$1        let l1_factory = portal;\n/'
	expect bind_factory_shadowed "_bind rebinds l1_factory"
	fixture bind_caller_sender 's/\[secret\], l1_factory, register_leaf_index/[secret], sender, register_leaf_index/; s/(fn _bind\(erc20: EthAddress,)/$1 sender: EthAddress,/'
	expect bind_caller_sender "_bind does not consume [secret] from l1_factory"

	# claim_from_pool.
	fixture claim_renamed 's/fn claim_from_pool\(/fn claim_from_pool_v2(/'
	expect claim_renamed "no single claim_from_pool function"
	fixture no_claim_salt 's/claim_salt/salt/g'
	expect no_claim_salt "claim_from_pool does not take claim_salt"
	fixture raw_secret 's/(        claim_salt: Field,\n)/$1        raw_secret: Field,\n/'
	expect raw_secret "claim_from_pool takes a secret parameter"
	fixture recipient_param 's/        let recipient = self\.msg_sender\(\);\n//; s/(        token: AztecAddress,\n)/$1        recipient: AztecAddress,\n/'
	expect recipient_param "claim_from_pool does not bind the recipient once to self.msg_sender()"
	fixture portal_param 's/        let portal = self\.storage\.portal_of\.at\(token\)\.read\(\);\n//; s/(        token: AztecAddress,\n)/$1        portal: EthAddress,\n/'
	expect portal_param "claim_from_pool does not read the portal once from portal_of.at(token)"
	fixture commitment_raw 's/hash_2\(\[change_precommitment, label\]\)/change_precommitment/'
	expect commitment_raw "claim_from_pool does not compute the commitment once as hash_2([change_precommitment, label])"
	fixture no_derive 's/        let secret = derive_claim_secret\(claim_salt, recipient\);\n//; s/\[secret\], portal/[claim_salt], portal/'
	expect no_derive "claim_from_pool does not derive the secret once from (claim_salt, recipient)"
	fixture secret_not_salt 's/derive_claim_secret\(claim_salt, recipient\)/derive_claim_secret(nullifier, recipient)/'
	expect secret_not_salt "claim_from_pool does not derive the secret once from (claim_salt, recipient)"
	fixture commented 's/(        )(let secret = derive_claim_secret\(claim_salt, recipient\);)/$1\/\/ $2/; s/(        )(self\.context\.consume_l1_to_l2_message\(content, \[secret\], portal, message_leaf_index\);)/$1\/\/ $2\n$1self.context.consume_l1_to_l2_message(content, [claim_salt], portal, message_leaf_index);/'
	expect commented "claim_from_pool does not derive the secret once from (claim_salt, recipient)"
	fixture shapes_in_string 's/(        )(let secret = derive_claim_secret\(claim_salt, recipient\);)/${1}let doc = "$2";/; s/\[secret\], portal/[claim_salt], portal/'
	expect shapes_in_string "claim_from_pool does not derive the secret once from (claim_salt, recipient)"
	fixture content_not_encoder 's/bridge_content_v1\(nullifier, commitment, amount\)/poseidon2_hash([nullifier, commitment, amount as Field])/'
	expect content_not_encoder "claim_from_pool does not build the content once with bridge_content_v1(nullifier, commitment, amount)"
	fixture recipient_shadowed 's/(let recipient = self\.msg_sender\(\);\n)/$1        let recipient = AztecAddress::from_field(label);\n/'
	expect recipient_shadowed "claim_from_pool rebinds recipient"
	fixture amount_shadowed 's/(let content = bridge_content_v1\(nullifier, commitment, amount\);\n)/$1        let amount = amount + 1;\n/'
	expect amount_shadowed "claim_from_pool rebinds amount"
	fixture derive_ignored 's/\[secret\], portal/[claim_salt], portal/'
	expect derive_ignored "claim_from_pool does not consume (content, [secret], portal, message_leaf_index)"
	fixture consume_via_helper 's/self\.context\.consume_l1_to_l2_message\(content, \[secret\], portal, message_leaf_index\);/self.internal._consume(content, [secret], portal, message_leaf_index);/; s/(\n}\n)$/\n    fn _consume(c: Field, s: [Field; 1], p: EthAddress, i: Field) { self.context.consume_l1_to_l2_message(c, s, p, i); }$1/'
	expect consume_via_helper "claim_from_pool does not consume (content, [secret], portal, message_leaf_index)"
	fixture mint_elsewhere 's/mint_from_bridge\(recipient, amount, label\)/mint_from_bridge(beneficiary, amount, label)/; s/(        token: AztecAddress,\n)/$1        beneficiary: AztecAddress,\n/'
	expect mint_elsewhere "claim_from_pool does not mint with self.call(LabelledToken::at(token).mint_from_bridge(recipient, amount, label))"
	fixture discarded_mint 's/self\.call\((LabelledToken::at\(token\)\.mint_from_bridge\(recipient, amount, label\))\);/let _ = $1;/'
	expect discarded_mint "claim_from_pool does not mint with self.call(LabelledToken::at(token).mint_from_bridge(recipient, amount, label))"

	if [ "$fails" -ne 0 ]; then
		echo "❌ check-sole-consumer self-test FAILED ($fails)" >&2
		exit 1
	fi
	echo "✅ check-sole-consumer self-test passed (the hub and the control upheld; $rejected bearer regressions rejected)"
}

if [ "${1:-}" = "--self-test" ]; then
	self_test
	exit 0
fi
crate="${1:-$here/token_bridge_hub}"
check_crate "$crate" || exit 1
echo "✅ sole-consumer invariant holds: $(basename "$crate") consumes at 2 sites (_bind, claim_from_pool) and no path dependency consumes; claim_from_pool's dataflow is pinned"
