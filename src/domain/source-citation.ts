/** An explicit, case-sensitive chunk id, not a substring of another path/id. */
export function explicitlyCitesSource(answer: string, chunkId: string): boolean {
	if (!chunkId) return false;
	const identifierCharacter = /[\p{L}\p{N}_./\\%#-]/u;
	for (let start = answer.indexOf(chunkId); start !== -1; start = answer.indexOf(chunkId, start + chunkId.length)) {
		const before = answer.slice(0, start).at(-1);
		const end = start + chunkId.length;
		const after = answer[end];
		// A sentence-ending period is punctuation; an appended extension is an id.
		const terminalPeriod = after === "." && (answer[end + 1] === undefined || /[\s\])}>"'»]/u.test(answer[end + 1]!));
		if ((!before || !identifierCharacter.test(before)) &&
			(!after || !identifierCharacter.test(after) || terminalPeriod)) return true;
	}
	return false;
}
