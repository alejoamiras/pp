/**
 * Recovery copy. Never promise recovery from keys alone without the exception: a device restored from
 * keys can show 0 until the wallet restores an earlier handshake.
 */

/** On the page, verbatim. */
export const RECOVERY_PLAIN =
	"You can leave from any device that has your account's keys. One exception: if your wallet agreed a private handshake with someone who paid you, those funds stay hidden on a restored device until your wallet restores that handshake's key."

/** In the Details drawer and the README, verbatim; backticks mark code. */
export const RECOVERY_PRECISE =
	"A holder can always leave from a device restored from the account's keys alone, with one exception: balance notes tagged under an interactive handshake that the holder's wallet signed for that note's (sender, holder) pair stay hidden until the wallet imports that handshake's ephemeral key (`eph_pk.x`). A wallet that signs interactive handshakes must back up each key. A wallet that cannot sign one, such as the embedded test wallet, is not affected."
