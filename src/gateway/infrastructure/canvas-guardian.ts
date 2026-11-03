/**
 * Preloaded into the upstream canvas process (`node --import`): when the
 * gateway that spawned it goes away (even on SIGKILL), its end of the stdin
 * pipe closes and the canvas exits instead of lingering as an orphan.
 */
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
