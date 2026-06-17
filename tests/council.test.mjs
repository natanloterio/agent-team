import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict } from "../scripts/lib/council.mjs";

const approve = (lens) => ({ lens, vote: "approve", findings: [] });
const reject = (lens, severity, note) => ({
  lens, vote: "reject", findings: [{ severity, note }],
});

test("strict majority with no critical → approved", () => {
  const v = computeVerdict(
    [approve("a"), approve("b"), reject("c", "minor", "nit")],
    { cycle: 1, maxCycles: 2 });
  assert.equal(v.decision, "approved");
  assert.equal(v.approveCount, 2);
  assert.equal(v.rejectCount, 1);
  assert.deepEqual(v.vetoes, []);
});

test("tie is not a majority → revise on cycle 1", () => {
  const v = computeVerdict(
    [approve("a"), approve("b"), reject("c", "minor", "x"), reject("d", "minor", "y")],
    { cycle: 1, maxCycles: 2 });
  assert.equal(v.decision, "revise");
  assert.match(v.reasons.join(" "), /no majority/);
});

test("critical finding vetoes even with majority approve", () => {
  const v = computeVerdict(
    [approve("a"), approve("b"), reject("sec", "critical", "secret leak")],
    { cycle: 1, maxCycles: 2 });
  assert.equal(v.decision, "revise");
  assert.equal(v.vetoes.length, 1);
  assert.equal(v.vetoes[0].lens, "sec");
  assert.match(v.reasons.join(" "), /CRITICAL veto \(sec\)/);
});

test("unresolved at max cycles → escalated", () => {
  const v = computeVerdict(
    [approve("a"), reject("sec", "critical", "still leaking")],
    { cycle: 2, maxCycles: 2 });
  assert.equal(v.decision, "escalated");
});

test("approval at max cycle is still approved (not escalated)", () => {
  const v = computeVerdict([approve("a"), approve("b")], { cycle: 2, maxCycles: 2 });
  assert.equal(v.decision, "approved");
});

test("empty votes throws", () => {
  assert.throws(() => computeVerdict([], { cycle: 1, maxCycles: 2 }), /non-empty/);
});

test("invalid cycle throws", () => {
  assert.throws(() => computeVerdict([approve("a")], { cycle: 0, maxCycles: 2 }), /cycle/);
});
