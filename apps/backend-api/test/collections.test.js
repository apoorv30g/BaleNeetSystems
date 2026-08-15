const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isThirdPartyAnswerer,
  debtDisclosureIssues,
  guardThirdPartyDisclosure,
  extractPromiseToPay
} = require("../src/services/collections");

// --- Third-party detection -------------------------------------------------

test("detects an answerer saying it is the wrong number or person", () => {
  assert.ok(isThirdPartyAnswerer("sorry, wrong number"));
  assert.ok(isThirdPartyAnswerer("this is not me"));
  assert.ok(isThirdPartyAnswerer("he is not here right now"));
  assert.ok(isThirdPartyAnswerer("she's not available"));
  assert.ok(isThirdPartyAnswerer("no such person here"));
  assert.ok(isThirdPartyAnswerer("does not live here"));
});

test("detects a relative or colleague answering", () => {
  assert.ok(isThirdPartyAnswerer("I am his wife"));
  assert.ok(isThirdPartyAnswerer("i'm her father"));
  assert.ok(isThirdPartyAnswerer("I am their colleague"));
});

test("detects Hindi and Hinglish third-party phrasing", () => {
  assert.ok(isThirdPartyAnswerer("galat number hai"));
  assert.ok(isThirdPartyAnswerer("गलत नंबर"));
  assert.ok(isThirdPartyAnswerer("wo ghar par nahi hai"));
  assert.ok(isThirdPartyAnswerer("वो घर पर नहीं है"));
  assert.ok(isThirdPartyAnswerer("kaun bol raha hai"));
});

test("does not flag the borrower confirming their own identity", () => {
  assert.ok(!isThirdPartyAnswerer("haan ji, main bol raha hoon"));
  assert.ok(!isThirdPartyAnswerer("yes this is me"));
  assert.ok(!isThirdPartyAnswerer("haan main hi hoon"));
  assert.ok(!isThirdPartyAnswerer(""));
});

// --- Debt disclosure guard -------------------------------------------------

test("flags debt-revealing content in a reply", () => {
  assert.ok(debtDisclosureIssues("Your EMI of 5000 is overdue").length > 0);
  assert.ok(debtDisclosureIssues("aapka ₹12,000 ka payment pending hai").length > 0);
  assert.ok(debtDisclosureIssues("your loan amount is due").length > 0);
  assert.ok(debtDisclosureIssues("आपका बकाया है").length > 0);
});

test("allows a neutral identity check that reveals no debt", () => {
  assert.deepEqual(debtDisclosureIssues("Namaste, kya main Rahul ji se baat kar raha hoon?"), []);
  assert.deepEqual(debtDisclosureIssues("Is this a good time to talk?"), []);
});

test("the guard blocks debt disclosure before identity is confirmed, and permits it after", () => {
  const reply = "Your EMI of 5000 is overdue";

  const beforeConfirm = guardThirdPartyDisclosure(reply, { identityConfirmed: false });
  assert.equal(beforeConfirm.safe, false, "must not discuss debt with an unidentified answerer");
  assert.ok(beforeConfirm.issues.length > 0);

  const afterConfirm = guardThirdPartyDisclosure(reply, { identityConfirmed: true });
  assert.equal(afterConfirm.safe, true, "once identity is confirmed the discussion is permitted");
});

test("a neutral greeting is safe even before identity is confirmed", () => {
  const result = guardThirdPartyDisclosure("Kya aap abhi baat kar sakte hain?", { identityConfirmed: false });
  assert.equal(result.safe, true);
});

// --- Promise to pay --------------------------------------------------------

const NOW = new Date("2026-08-15T10:00:00Z");

test("captures an amount and a relative date", () => {
  const ptp = extractPromiseToPay("main kal 5000 pay kar dunga", NOW);
  assert.ok(ptp);
  assert.equal(ptp.amount, 5000);
  assert.equal(ptp.date, "2026-08-16");
});

test("captures a rupee-formatted amount with separators", () => {
  const ptp = extractPromiseToPay("I will pay ₹12,500 tomorrow", NOW);
  assert.ok(ptp);
  assert.equal(ptp.amount, 12500);
  assert.equal(ptp.date, "2026-08-16");
});

test("captures an explicit day of month", () => {
  const ptp = extractPromiseToPay("I will pay on the 20th", NOW);
  assert.ok(ptp);
  assert.equal(ptp.date, "2026-08-20");
});

test("rolls a past day-of-month into next month", () => {
  const ptp = extractPromiseToPay("payment karunga 5 tarikh ko", NOW);
  assert.ok(ptp);
  assert.equal(ptp.date, "2026-09-05", "a day already past must mean next month");
});

test("returns null without a payment intent", () => {
  assert.equal(extractPromiseToPay("mera number 5000 hai", NOW), null);
  assert.equal(extractPromiseToPay("kal baat karte hain", NOW), null);
  assert.equal(extractPromiseToPay("", NOW), null);
});

test("returns null when intent has neither amount nor date", () => {
  // "I'll pay" with no commitment attached is not a promise a collections team can act on.
  assert.equal(extractPromiseToPay("haan main pay kar dunga", NOW), null);
});

test("ignores implausible amounts rather than recording a false commitment", () => {
  // A wrongly-recorded promise causes a wasted, annoying follow-up call.
  const tiny = extractPromiseToPay("I will pay 5 tomorrow", NOW);
  assert.equal(tiny.amount, null, "a stray small number must not become an amount");
  assert.equal(tiny.date, "2026-08-16", "the date is still a real commitment");
});

test("captures date-only and amount-only promises", () => {
  const dateOnly = extractPromiseToPay("kal pay kar dunga", NOW);
  assert.equal(dateOnly.amount, null);
  assert.equal(dateOnly.date, "2026-08-16");

  const amountOnly = extractPromiseToPay("I will pay 3000", NOW);
  assert.equal(amountOnly.amount, 3000);
  assert.equal(amountOnly.date, null);
});

test("keeps the raw utterance for audit", () => {
  const ptp = extractPromiseToPay("main kal 5000 pay kar dunga", NOW);
  assert.match(ptp.raw, /5000/);
});
