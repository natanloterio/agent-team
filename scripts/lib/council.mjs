// Pure decision logic for the technical council (Conselho).
// Given one cycle's reviewer votes for a block, decide whether the proposed
// subtasks are approved, must be revised, or must be escalated to a human.
//
// A vote: { lens: string, vote: "approve"|"reject", findings: [{severity, note}] }
// Severity ladder: "info" < "minor" < "major" < "critical".
// Rule: strict majority of "approve" AND zero "critical" findings → approved.
//       Otherwise revise, unless this was the last allowed cycle → escalated.

export const SEVERITIES = Object.freeze(["info", "minor", "major", "critical"]);

export function computeVerdict(votes, { cycle, maxCycles } = {}) {
  if (!Array.isArray(votes) || votes.length === 0)
    throw new Error("votes must be a non-empty array");
  if (!Number.isInteger(cycle) || cycle < 1)
    throw new Error("cycle must be an integer >= 1");
  if (!Number.isInteger(maxCycles) || maxCycles < 1)
    throw new Error("maxCycles must be an integer >= 1");

  for (const v of votes) {
    if (v.vote !== "approve" && v.vote !== "reject")
      throw new Error(`invalid vote "${v.vote}" for lens "${v.lens}"`);
  }

  const approveCount = votes.filter((v) => v.vote === "approve").length;
  const rejectCount = votes.length - approveCount;

  const vetoes = votes.flatMap((v) =>
    (v.findings ?? [])
      .filter((f) => f.severity === "critical")
      .map((f) => ({ lens: v.lens, note: f.note })));

  const known = new Set(SEVERITIES);
  for (const v of votes) {
    for (const f of v.findings ?? []) {
      if (!known.has(f.severity))
        throw new Error(`invalid severity "${f.severity}" for lens "${v.lens}"`);
    }
  }

  // Strict majority: strictly more than half approve.
  const hasMajority = approveCount * 2 > votes.length;
  const approved = hasMajority && vetoes.length === 0;

  if (approved)
    return { decision: "approved", approveCount, rejectCount, vetoes, reasons: [] };

  const reasons = [];
  if (!hasMajority) reasons.push(`no majority: ${approveCount}/${votes.length} approved`);
  for (const v of vetoes) reasons.push(`CRITICAL veto (${v.lens}): ${v.note}`);

  const decision = cycle >= maxCycles ? "escalated" : "revise";
  return { decision, approveCount, rejectCount, vetoes, reasons };
}
