#!/usr/bin/env bash
# Sole-consumer invariant: the hub consumes L1→L2 messages at exactly two sites, `_bind` (the
# factory's `register` message) and `claim_from_pool` (a pool withdrawal's bridge message), and no
# path dependency consumes at all. `claim_from_pool` must take the recipient from its caller and
# rebuild both the content and the secret from its own arguments, so a claim is never a bearer
# instrument: a stray consume, a raw secret, a recipient or portal from a parameter, or a content or
# commitment built any other way would let a party holding a deposit's data redirect or forge it.
#
# A static tripwire: the TXE cases prove the semantics; this pins the dataflow they rely on. Sources
# are scanned with comments removed and each string literal (raw ones included) hex-encoded, so no
# string can fake code or unbalance a brace, then flattened to one line so a multi-line signature or
# body matches one regex. Every source counts, tests included: Noir compiles a crate's test module
# with it. `--self-test` replays crafted regressions, each of which must fail with its own reason.
#
# The nullifier primitives are banned in the hub and every path dependency, except the statements in
# EXEMPT_* below. A message's nullifier is pushed by the contract that consumes it, under that
# contract's address (aztec-nr v6.0.0 `PrivateContext::consume_l1_to_l2_message`), and every pushed
# nullifier is siloed with the address of the frame that pushed it (`push_nullifier_unsafe`). An
# `#[external]` entrypoint builds its own context from the kernel's inputs, so it always runs as its
# own contract and cannot nullify or pre-empt a hub message. An `#[internal]` function or a
# `#[contract_library_method]` takes its caller's context and runs as whoever calls it, the hub
# included, so neither is ever exempt. A root crate is never exempt either.
#
# Usage: check-sole-consumer.sh [--self-test | <hub crate dir>]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One exempt statement per index (crate, file, function header, statement, and with EXEMPT_ONCE a
# function name). Every condition must hold, or the statement counts and the violation names the
# condition and the constant to update:
# - the crate is a contract-type path dependency in the hub's sibling directory of its name, and its
#   Nargo.toml names it plainly in [package] (no multi-line string anywhere in the file);
# - neither it nor its path dependencies hold `quote`, a `comptime` item or an alias named `external`
#   or `internal`, so no user macro can copy or rewrite the function and the attribute is aztec-nr's;
# - the header is in the file once, with no other attribute before it, and the statement is once in
#   its brace-matched body;
# - an EXEMPT_ONCE name appears nowhere else in the crate. The function is private, and Noir refuses
#   a call to it from any other module, so only `nargo test` runs it.
# `shield` is a private entrypoint, so it runs as the token. The test pushes from the token's address
# in TXE.
EXEMPT_CRATE=(labelled_token labelled_token)
EXEMPT_FILE=(src/main.nr src/test/shield.nr)
EXEMPT_HEAD=(
	'#[external("private")] fn shield(amount: u128) {'
	'#[test(should_fail_with = "NullifierLeafValue is not updateable")] unconstrained fn shield_failure_repeated_secret() {'
)
EXEMPT_STMT=(
	'self.context.push_nullifier_unsafe(birth_nullifier(owner, secret));'
	's.env.private_context_at(s.token, |context| context.push_nullifier_unsafe(repeat));'
)
EXEMPT_ONCE=('' shield_failure_repeated_secret)

# Removes comments (nested block comments included, as Noir nests them) and hex-encodes each string
# literal's contents, raw strings (`r#"…"#`) included, in one string-aware pass, so neither a comment
# nor a string can hide or fake live code.
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
			my $c = substr($s, $i, 1);
			if ($c eq "r" && ($i == 0 || substr($s, $i - 1, 1) !~ /\w/) && substr($s, $i, 300) =~ /^r(#*)"/) {
				my $end = "\"" . $1;
				my $from = $i + length($1) + 2;
				my $j = index($s, $end, $from);
				$j = $n if $j < 0;
				$o .= "\"x" . unpack("H*", substr($s, $from, $j - $from)) . "\"";
				$i = $j + length $end;
				next;
			}
			if ($c eq "\"") {
				my $j = $i + 1;
				while ($j < $n && substr($s, $j, 1) ne "\"") { $j += substr($s, $j, 1) eq "\\" ? 2 : 1 }
				$o .= "\"x" . unpack("H*", substr($s, $i + 1, $j - $i - 1)) . "\"";
				$i = $j + 1;
				next;
			}
			$o .= $c;
			$i++;
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

# Every source of the crate at $1, each cleaned on its own (a comment left open at the end of one
# file must not swallow the next), then flattened.
crate_source() {
	local f
	while IFS= read -r -d '' f; do
		clean <"$f"
		printf ' '
	done < <(find "$1/src" -name '*.nr' -print0 | sort -z)
}

# Records why an exemption does not apply, for the violation that the counted statement then causes.
drift() {
	printf '%s\n' "$*" >>"$DRIFT_LOG"
}

# The cleaned text $1 without the statement $3, if the cleaned header $2 is there exactly once with
# no attribute before it and its brace-matched body holds $3 exactly once. Otherwise $1 unchanged,
# exiting 2 (header not there once), 3 (an attribute before it), 4 (body never closes) or 5
# (statement not in the body once).
drop_exempt() {
	printf '%s' "$1" | HEAD="$2" STMT="$3" perl -0777 -ne '
		my ($s, $h, $t) = ($_, $ENV{HEAD}, $ENV{STMT});
		my $at = index($s, $h);
		if ($at < 0 || index($s, $h, $at + 1) >= 0) { print $s; exit 2 }
		my $pre = substr($s, 0, $at);
		$pre =~ s/\s+\z//;
		if ($pre ne "" && $pre !~ /[{};]\z/) { print $s; exit 3 }
		my ($open, $d, $i) = ($at + length($h) - 1, 0, 0);
		for ($i = $open; $i < length $s; $i++) {
			my $c = substr($s, $i, 1);
			$d++ if $c eq "{";
			$d-- if $c eq "}";
			last if !$d;
		}
		if ($d) { print $s; exit 4 }
		my $body = substr($s, $open, $i - $open + 1);
		my $k = index($body, $t);
		if ($k < 0 || index($body, $t, $k + 1) >= 0) { print $s; exit 5 }
		substr($body, $k, length $t) = "";
		print substr($s, 0, $open), $body, substr($s, $i + 1);
	'
}

# "<name> <type>" from the [package] table of the Nargo.toml at $1; nothing unless each key is there
# exactly once as a plain string and the file holds no multi-line string.
package_id() {
	perl -ne '
		our ($table, $bad, %seen, %value);
		$table //= "";
		$bad = 1 if /"""|\x27\x27\x27/;
		if (/^\s*\[([^\]]*)\]\s*(#.*)?$/) { ($table = $1) =~ s/\s//g; next }
		next if $table ne "package";
		if (/^\s*(name|type)\s*=\s*"([^"\\]*)"\s*(#.*)?$/) { $seen{$1}++; $value{$1} = $2; next }
		$bad = 1 if /^\s*["\x27]?(name|type)\b/;
		END { print "$value{name} $value{type}" if !$bad && ($seen{name} // 0) == 1 && ($seen{type} // 0) == 1 }
	' "$1"
}

# Whether the crate at $1 and its path dependencies hold no `quote`, no `comptime` item (a
# `comptime { … }` block stays allowed) and no alias that makes `external` or `internal` name another
# item, so neither a user macro nor a renamed one can copy or rewrite the exempt function.
macro_free() {
	local dir
	local -a dirs=("$1")
	mapfile -t -O 1 dirs < <(path_deps "$1")
	for dir in "${dirs[@]}"; do
		[ -n "$dir" ] || continue
		[ "$(count '\bquote\b|\bcomptime[[:space:]]*[^{[:space:]]|\bas[[:space:]]+(external|internal)\b' "$(crate_source "$dir")")" -eq 0 ] || return 1
	done
}

# Why the path dependency at $1, claiming exempt crate $2, cannot hold exemptions for the hub at $3,
# given its "<name> <type>" $4; nothing if it can.
crate_drift() {
	local dep="$1" claim="$2" hub="$3" id="$4"
	if [ "$id" != "$claim ${id#* }" ] || [ -z "$id" ]; then
		echo "its Nargo.toml must give [package] name = \"$claim\" and a type once each, as plain strings, with no multi-line string"
	elif [ "$id" != "$claim contract" ]; then
		echo "it is not a contract"
	elif [ "$dep" != "$(cd "$hub/.." && pwd)/$claim" ]; then
		echo "it is not in the hub's sibling directory $claim"
	elif ! macro_free "$dep"; then
		echo "it or a path dependency holds quote, a comptime item or an alias named external or internal"
	fi
}

# Every source of the path dependency at $1 of the hub at $2, cleaned and flattened, without the
# exempt statements that meet every condition above. Each that does not is recorded by `drift`.
dep_source() {
	local dep="$1" hub="$2" id claim c why f i k all head stmt out rc found
	local -a files=() texts=()
	while IFS= read -r -d '' f; do
		files+=("${f#"$dep/"}")
		texts+=("$(clean <"$f")")
	done < <(find "$dep/src" -name '*.nr' -print0 | sort -z)
	id=$(package_id "$dep/Nargo.toml")
	claim=""
	for c in "${EXEMPT_CRATE[@]}"; do
		if [ "$c" = "$(basename "$dep")" ] || [ "$c" = "${id% *}" ]; then claim=$c; fi
	done
	if [ -n "$claim" ]; then
		why=$(crate_drift "$dep" "$claim" "$hub" "$id")
		if [ -n "$why" ]; then
			drift "$claim no longer qualifies for its exemptions: $why"
			claim=""
		fi
	fi
	all="${texts[*]}"
	for i in "${!EXEMPT_CRATE[@]}"; do
		[ -n "$claim" ] && [ "${EXEMPT_CRATE[$i]}" = "$claim" ] || continue
		if [ -n "${EXEMPT_ONCE[$i]}" ] && [ "$(count "\\b${EXEMPT_ONCE[$i]}\\b" "$all")" -ne 1 ]; then
			drift "$claim: ${EXEMPT_ONCE[$i]}, pinned in EXEMPT_ONCE[$i], does not appear exactly once in the crate; update EXEMPT_ONCE[$i] in the same change"
			continue
		fi
		head=$(printf '%s' "${EXEMPT_HEAD[$i]}" | clean)
		stmt=$(printf '%s' "${EXEMPT_STMT[$i]}" | clean)
		found=""
		for k in "${!files[@]}"; do
			[ "${files[$k]}" = "${EXEMPT_FILE[$i]}" ] || continue
			found=1
			rc=0
			out=$(drop_exempt "${texts[$k]}" "$head" "$stmt") || rc=$?
			texts[k]=$out
			case $rc in
			2) drift "$claim ${EXEMPT_FILE[$i]}: the header pinned in EXEMPT_HEAD[$i] is not there exactly once; update EXEMPT_HEAD[$i] in the same change" ;;
			3) drift "$claim ${EXEMPT_FILE[$i]}: an attribute precedes the header pinned in EXEMPT_HEAD[$i]; update EXEMPT_HEAD[$i] in the same change" ;;
			4) drift "$claim ${EXEMPT_FILE[$i]}: the body under EXEMPT_HEAD[$i] does not close" ;;
			5) drift "$claim ${EXEMPT_FILE[$i]}: the statement pinned in EXEMPT_STMT[$i] is not in that function's body exactly once; update EXEMPT_STMT[$i] in the same change" ;;
			esac
		done
		[ -n "$found" ] || drift "$claim ${EXEMPT_FILE[$i]}: the file pinned in EXEMPT_FILE[$i] is gone; update EXEMPT_FILE[$i] in the same change"
	done
	printf '%s ' "${texts[@]}"
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
		done < <(sed -nE "s/.*path[[:space:]]*=[[:space:]]*[\"']([^\"']+)[\"'].*/\\1/p" "$dir/Nargo.toml")
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

	if [ "$(count 'consume_l1_to_l2_message\(' "$body")" -ne 1 ] ||
		! printf '%s' "$body" | grep -qE "consume_l1_to_l2_message\($c, \[$s\], $p, message_leaf_index\)"; then
		violation "claim_from_pool does not consume (content, [secret], portal, message_leaf_index)"
		return 1
	fi
	printf '%s' "$body" | grep -qE "self\.call\(LabelledToken::at\(token\)\.mint_from_bridge\($r, amount, label\)\);" ||
		{ violation "claim_from_pool does not mint with self.call(LabelledToken::at(token).mint_from_bridge(recipient, amount, label))"; return 1; }
}

# Returns 0 if the hub crate at $1 upholds the invariant, 1 with one reason on stderr otherwise.
check_crate() {
	local rc=0
	DRIFT_LOG=$(mktemp)
	check_hub "$1" || rc=$?
	rm -f "$DRIFT_LOG"
	return "$rc"
}

check_hub() {
	local crate="$1" src deps dep n line why
	[ -f "$crate/src/main.nr" ] || { echo "SOLE-CONSUMER: no such crate: $crate" >&2; return 1; }
	src=$(crate_source "$crate")
	deps=$(path_deps "$crate") || return 1

	n=$(count 'consume_l1_to_l2_message' "$src")
	[ "$n" -eq 2 ] || { violation "expected 2 consume_l1_to_l2_message sites in the hub, found $n"; return 1; }
	local all="$src"
	while IFS= read -r dep; do
		[ -n "$dep" ] || continue
		local dsrc
		dsrc=$(dep_source "$dep" "$crate")
		[ "$(count 'consume_l1_to_l2_message' "$dsrc")" -eq 0 ] ||
			{ violation "a path dependency consumes an L1 to L2 message: $(basename "$dep")"; return 1; }
		all="$all $dsrc"
	done <<<"$deps"
	# These consume or nullify a message without consume_l1_to_l2_message. A pinned site that no
	# longer matches is named, so its constant can follow the change that moved it.
	if [ "$(count 'process_l1_to_l2_message|push_nullifier' "$all")" -ne 0 ]; then
		why="a lower-level messaging or nullifier primitive is present"
		while IFS= read -r line; do why="$why; $line"; done <"$DRIFT_LOG"
		violation "$why"
		return 1
	fi
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

# A minimal token in the real one's shape: its two exempt statements, and an internal function that
# runs in its caller's context.
TOKEN_MAIN='mod test;
contract LabelledToken {
    #[external("private")]
    fn shield(amount: u128) {
        let owner = self.msg_sender();
        let secret = unsafe { random() };
        self.context.push_nullifier_unsafe(birth_nullifier(owner, secret));
    }

    #[internal("private")]
    fn _spend(owner: AztecAddress, amount: u128) {
        self.storage.private_balances.at(owner).sub(amount);
    }
}
'
TOKEN_TEST='#[test(should_fail_with = "NullifierLeafValue is not updateable")]
unconstrained fn shield_failure_repeated_secret() {
    let s = funded();
    let repeat = birth_nullifier(s.user, s.secret);
    s.env.private_context_at(s.token, |context| context.push_nullifier_unsafe(repeat));
}

#[test]
unconstrained fn shield_once() {
    let s = funded();
    shield(s, 20);
}
'

# Gives fixture $1 a path dependency named labelled_token of type $4 (default contract), in directory
# $5 (default labelled_token): TOKEN_MAIN and TOKEN_TEST with the perl substitutions $2 and $3 applied
# (an empty one keeps the source).
token_dep() {
	local hub="$tmp/$1/hub" dir="$tmp/$1/${5:-labelled_token}" main test main0 test0
	mkdir -p "$dir/src/test"
	printf 'labelled_token = { path = "../%s" }\n' "${5:-labelled_token}" >>"$hub/Nargo.toml"
	printf '[package]\nname = "labelled_token"\ntype = "%s"\n' "${4:-contract}" >"$dir/Nargo.toml"
	main0=$(printf '%s' "$TOKEN_MAIN")
	test0=$(printf '%s' "$TOKEN_TEST")
	main=$(printf '%s' "$TOKEN_MAIN" | perl -0777 -pe "$2")
	test=$(printf '%s' "$TOKEN_TEST" | perl -0777 -pe "$3")
	if { [ -n "$2" ] && [ "$main" = "$main0" ]; } || { [ -n "$3" ] && [ "$test" = "$test0" ]; }; then
		echo "SELF-TEST FAIL: fixture $1 does not mutate the token" >&2
		fails=$((fails + 1))
	fi
	printf '%s' "$main" >"$dir/src/main.nr"
	printf '%s' "$test" >"$dir/src/test/shield.nr"
}

# Fixture $1 must be rejected with exactly the reason $2.
expect() {
	local got
	if got=$(check_crate "$tmp/$1/${3:-hub}" 2>&1 >/dev/null); then
		echo "SELF-TEST FAIL: $1 accepted" >&2
		fails=$((fails + 1))
	elif [ "$got" != "SOLE-CONSUMER VIOLATION: $2" ]; then
		echo "SELF-TEST FAIL: $1 rejected for another reason: '$got' (expected '$2')" >&2
		fails=$((fails + 1))
	else
		rejected=$((rejected + 1))
	fi
}

# The fixtures are perl substitutions: `$1` is a capture group, never a shell expansion.
# shellcheck disable=SC2016
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
	fixture raw_string 's/(        let portal =)/        let quoted = r#"a"b"#;\n        let m = self.context.process_l1_to_l2_message(claim_salt, message_leaf_index);\n$1/'
	expect raw_string "a lower-level messaging or nullifier primitive is present"
	# Nullifier pushes: only the token's two exempt statements pass, and only where they stand.
	local primitive="a lower-level messaging or nullifier primitive is present"
	local t0="labelled_token src/main.nr" t1="labelled_token src/test/shield.nr"
	local off="$primitive; labelled_token no longer qualifies for its exemptions:"
	local macros="$off it or a path dependency holds quote, a comptime item or an alias named external or internal"
	local head0="$primitive; $t0: the header pinned in EXEMPT_HEAD[0] is not there exactly once; update EXEMPT_HEAD[0] in the same change"
	local head1="$primitive; $t1: the header pinned in EXEMPT_HEAD[1] is not there exactly once; update EXEMPT_HEAD[1] in the same change"
	local stmt0="$primitive; $t0: the statement pinned in EXEMPT_STMT[0] is not in that function's body exactly once; update EXEMPT_STMT[0] in the same change"
	local stmt1="$primitive; $t1: the statement pinned in EXEMPT_STMT[1] is not in that function's body exactly once; update EXEMPT_STMT[1] in the same change"
	fixture token_control 's/(\n}\n)$/\n$1/'
	token_dep token_control '' ''
	check_crate "$tmp/token_control/hub" >/dev/null 2>&1 || { echo "SELF-TEST FAIL: the control with a token is rejected" >&2; fails=$((fails + 1)); }
	fixture hub_exempt_text 's/(\n}\n)$/\n    #[external("private")]\n    fn shield(amount: u128) {\n        self.context.push_nullifier_unsafe(birth_nullifier(owner, secret));\n    }$1/'
	# A root named and placed as the token would be, so only the root exclusion refuses it.
	perl -pi -e 's/^name = "hub"$/name = "labelled_token"/' "$tmp/hub_exempt_text/hub/Nargo.toml"
	mv "$tmp/hub_exempt_text/hub" "$tmp/hub_exempt_text/labelled_token"
	expect hub_exempt_text "$primitive" labelled_token
	fixture lib_push 's/(\n}\n)$/\n$1/'
	printf 'evil = { path = "../evil" }\n' >>"$tmp/lib_push/hub/Nargo.toml"
	mkdir -p "$tmp/lib_push/evil/src"
	printf '[package]\nname = "evil"\ntype = "lib"\n' >"$tmp/lib_push/evil/Nargo.toml"
	printf 'pub fn nullify(context: &mut PrivateContext, n: Field) {\n    context.push_nullifier_unsafe(n);\n}\n' >"$tmp/lib_push/evil/src/lib.nr"
	expect lib_push "$primitive"
	fixture token_as_lib 's/(\n}\n)$/\n$1/'
	token_dep token_as_lib '' '' lib
	expect token_as_lib "$off it is not a contract"
	fixture token_second_push 's/(\n}\n)$/\n$1/'
	token_dep token_second_push 's/(        self\.context\.push_nullifier_unsafe\(birth_nullifier\(owner, secret\)\);\n)/$1$1/' ''
	expect token_second_push "$stmt0"
	fixture token_other_value 's/(\n}\n)$/\n$1/'
	token_dep token_other_value 's/push_nullifier_unsafe\(birth_nullifier\(owner, secret\)\)/push_nullifier_unsafe(compute_l1_to_l2_message_nullifier(content, [secret]))/' ''
	expect token_other_value "$stmt0"
	fixture token_internal_push 's/(\n}\n)$/\n$1/'
	token_dep token_internal_push 's/(        self\.storage\.private_balances)/        self.context.push_nullifier_unsafe(birth_nullifier(owner, secret));\n$1/' ''
	expect token_internal_push "$primitive"
	fixture token_moved_push 's/(\n}\n)$/\n$1/'
	token_dep token_moved_push 's/        self\.context\.push_nullifier_unsafe\(birth_nullifier\(owner, secret\)\);\n//; s/(        self\.storage\.private_balances)/        self.context.push_nullifier_unsafe(birth_nullifier(owner, secret));\n$1/' ''
	expect token_moved_push "$stmt0"
	fixture token_shield_internal 's/(\n}\n)$/\n$1/'
	token_dep token_shield_internal 's/#\[external\("private"\)\]\n    fn shield/#[internal("private")]\n    fn shield/' ''
	expect token_shield_internal "$head0"
	fixture token_header_twice 's/(\n}\n)$/\n$1/'
	token_dep token_header_twice 's/        self\.context\.push_nullifier_unsafe\(birth_nullifier\(owner, secret\)\);\n//; s/^contract LabelledToken \{\n/mod m {\n    #[external("private")]\n    fn shield(amount: u128) {\n        self.context.push_nullifier_unsafe(birth_nullifier(owner, secret));\n    }\n}\ncontract LabelledToken {\n/m' ''
	expect token_header_twice "$head0"
	fixture token_process 's/(\n}\n)$/\n$1/'
	token_dep token_process 's/(        let secret =)/        let m = self.context.process_l1_to_l2_message(amount, secret);\n$1/' ''
	expect token_process "$primitive"
	fixture token_test_elsewhere 's/(\n}\n)$/\n$1/'
	token_dep token_test_elsewhere '' 's/(    shield\(s, 20\);\n)/$1    s.env.private_context_at(s.token, |context| context.push_nullifier_unsafe(repeat));\n/'
	expect token_test_elsewhere "$primitive"
	fixture token_test_moved 's/(\n}\n)$/\n$1/'
	token_dep token_test_moved '' 's/    s\.env\.private_context_at\(s\.token, \|context\| context\.push_nullifier_unsafe\(repeat\)\);\n//; s/(    shield\(s, 20\);\n)/$1    s.env.private_context_at(s.token, |context| context.push_nullifier_unsafe(repeat));\n/'
	expect token_test_moved "$stmt1"
	fixture token_test_other_value 's/(\n}\n)$/\n$1/'
	token_dep token_test_other_value '' 's/push_nullifier_unsafe\(repeat\)/push_nullifier_unsafe(message)/'
	expect token_test_other_value "$stmt1"
	fixture token_test_other_frame 's/(\n}\n)$/\n$1/'
	token_dep token_test_other_frame '' 's/private_context_at\(s\.token,/private_context_at(s.hub,/'
	expect token_test_other_frame "$stmt1"
	fixture token_test_called 's/(\n}\n)$/\n$1/'
	token_dep token_test_called '' 's/$/\npub unconstrained fn push() {\n    shield_failure_repeated_secret();\n}\n/'
	expect token_test_called "$primitive; labelled_token: shield_failure_repeated_secret, pinned in EXEMPT_ONCE[1], does not appear exactly once in the crate; update EXEMPT_ONCE[1] in the same change"
	fixture token_test_pub 's/(\n}\n)$/\n$1/'
	token_dep token_test_pub '' 's/^unconstrained fn shield_failure_repeated_secret/pub unconstrained fn shield_failure_repeated_secret/m'
	expect token_test_pub "$head1"
	fixture token_public_shield 's/(\n}\n)$/\n$1/'
	token_dep token_public_shield 's/#\[external\("private"\)\]\n    fn shield/#[external("public")]\n    fn shield/' ''
	expect token_public_shield "$head0"
	fixture token_attribute_before 's/(\n}\n)$/\n$1/'
	token_dep token_attribute_before 's/(    #\[external\("private"\)\]\n    fn shield)/    #[clone_to_library]\n$1/' ''
	expect token_attribute_before "$primitive; $t0: an attribute precedes the header pinned in EXEMPT_HEAD[0]; update EXEMPT_HEAD[0] in the same change"
	fixture token_comptime_fn 's/(\n}\n)$/\n$1/'
	token_dep token_comptime_fn 's/^mod test;\n/mod test;\npub comptime fn clone_to_library(f: FunctionDefinition) {}\n/' ''
	expect token_comptime_fn "$macros"
	fixture token_quote 's/(\n}\n)$/\n$1/'
	token_dep token_quote 's/(        self\.storage\.private_balances)/        let _ = quote { x };\n$1/' ''
	expect token_quote "$macros"
	fixture token_dep_comptime 's/(\n}\n)$/\n$1/'
	token_dep token_dep_comptime '' ''
	printf '[dependencies]\nmacros = { path = "../macros" }\n' >>"$tmp/token_dep_comptime/labelled_token/Nargo.toml"
	mkdir -p "$tmp/token_dep_comptime/macros/src"
	printf '[package]\nname = "macros"\ntype = "lib"\n' >"$tmp/token_dep_comptime/macros/Nargo.toml"
	printf 'pub comptime fn external(f: FunctionDefinition, kind: CtString) {}\n' >"$tmp/token_dep_comptime/macros/src/lib.nr"
	expect token_dep_comptime "$macros"
	# A raw string whose quotes hold an opening brace: lexed as plain strings, it would stretch
	# `shield`'s body over `_spend`, whose push would then pass as `shield`'s.
	fixture token_raw_brace 's/(\n}\n)$/\n$1/'
	token_dep token_raw_brace 's/        self\.context\.push_nullifier_unsafe\(birth_nullifier\(owner, secret\)\);\n/        let _ = r#" "{" "#;\n/; s/(        self\.storage\.private_balances)/        self.context.push_nullifier_unsafe(birth_nullifier(owner, secret));\n$1/' ''
	expect token_raw_brace "$stmt0"
	fixture token_unclosed 's/(\n}\n)$/\n$1/'
	token_dep token_unclosed 's/        self\.context\.push_nullifier_unsafe\(birth_nullifier\(owner, secret\)\);\n    \}\n//; s/(        self\.storage\.private_balances)/        self.context.push_nullifier_unsafe(birth_nullifier(owner, secret));\n$1/; s/\n\}\n\z/\n/' ''
	expect token_unclosed "$primitive; $t0: the body under EXEMPT_HEAD[0] does not close"
	fixture token_toml_multiline 's/(\n}\n)$/\n$1/'
	token_dep token_toml_multiline '' '' lib
	printf '[package]\ndescription = """\nname = "labelled_token"\ntype = "contract"\n"""\n' >"$tmp/token_toml_multiline/labelled_token/Nargo.toml"
	expect token_toml_multiline "$off its Nargo.toml must give [package] name = \"labelled_token\" and a type once each, as plain strings, with no multi-line string"
	fixture token_toml_spoof 's/(\n}\n)$/\n$1/'
	token_dep token_toml_spoof '' '' lib
	printf '[package]\nauthors = ["""\nname = "labelled_token"\ntype = "contract"\n"""]\nname = "labelled_token"\ntype = "lib"\n' >"$tmp/token_toml_spoof/labelled_token/Nargo.toml"
	expect token_toml_spoof "$off its Nargo.toml must give [package] name = \"labelled_token\" and a type once each, as plain strings, with no multi-line string"
	fixture token_alias 's/(\n}\n)$/\n$1/'
	token_dep token_alias 's/^mod test;\n/mod test;\nuse aztec::macros::functions::internal as external;\n/' ''
	expect token_alias "$macros"
	fixture token_elsewhere 's/(\n}\n)$/\n$1/'
	token_dep token_elsewhere '' '' contract vendored
	expect token_elsewhere "$off it is not in the hub's sibling directory labelled_token"

	# A line comment left open at the end of one file must not swallow the next file's first line.
	fixture split_comment 's/(\n}\n)$/\n$1/'
	printf 'global NOTE: Field = 0; // trailing' >"$tmp/split_comment/hub/src/a.nr"
	printf 'fn nullify(context: &mut PrivateContext, n: Field) { context.push_nullifier_unsafe(n); }\n' >"$tmp/split_comment/hub/src/b.nr"
	expect split_comment "$primitive"
	fixture quoted_path_dep 's/(\n}\n)$/\n$1/'
	printf "evil = { path = '../evil' }\n" >>"$tmp/quoted_path_dep/hub/Nargo.toml"
	mkdir -p "$tmp/quoted_path_dep/evil/src"
	printf '[package]\nname = "evil"\ntype = "lib"\n' >"$tmp/quoted_path_dep/evil/Nargo.toml"
	printf 'pub fn take(context: &mut PrivateContext, c: Field, s: Field, p: EthAddress, i: Field) {\n    context.consume_l1_to_l2_message(c, [s], p, i);\n}\n' >"$tmp/quoted_path_dep/evil/src/lib.nr"
	expect quoted_path_dep "a path dependency consumes an L1 to L2 message: evil"

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
