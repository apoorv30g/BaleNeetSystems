const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/services/complianceAudit");

function line(speaker, text) { return { speaker, text }; }

test("a clean call scores 100 and passes", () => {
  const result = _test.auditTranscript({
    transcript: [
      line("assistant", "नमस्ते, यह ASAP Finance की तरफ से call है। क्या मेरी बात Prasheel जी से हो रही है?"),
      line("user", "हां जी"),
      line("assistant", "आपका PAN verification pending है। www.asapfinance.in पर complete कीजिए।")
    ],
    outcome: "INTERESTED",
    brandName: "ASAP Finance",
    callHourIst: 14,
    callWindow: { start: 9, end: 20 }
  });
  assert.equal(result.score, 100);
  assert.equal(result.verdict, "pass");
  assert.equal(result.flags.length, 0);
});

test("asking the customer for an OTP is a hard fail with evidence", () => {
  const result = _test.auditTranscript({
    transcript: [
      line("assistant", "ASAP Finance से बोल रही हूँ।"),
      line("user", "ok"),
      line("assistant", "आपका OTP बता दीजिए मुझे")
    ],
    brandName: "ASAP Finance",
    callHourIst: 12,
    callWindow: { start: 9, end: 20 }
  });
  assert.equal(result.checks.no_otp_request, false);
  assert.ok(result.flags.some(f => f.check === "no_otp_request"));
  assert.ok(result.score < 90);
});

test("the standard 'we will never ask for OTP' disclaimer does NOT trip the OTP check", () => {
  const result = _test.auditTranscript({
    transcript: [
      line("assistant", "ASAP Finance से call है।"),
      line("user", "ok"),
      line("assistant", "हम इस call पर कभी भी OTP, PIN या password नहीं पूछेंगे। इन्हें सिर्फ official website पर ही डालिए।")
    ],
    brandName: "ASAP Finance",
    callHourIst: 12,
    callWindow: { start: 9, end: 20 }
  });
  assert.equal(result.checks.no_otp_request, true);
});

test("guaranteed-approval promise is flagged", () => {
  const result = _test.auditTranscript({
    transcript: [line("assistant", "ASAP Finance. आपको loan पक्का मिल जाएगा, guaranteed approval है।")],
    brandName: "ASAP Finance", callHourIst: 12, callWindow: { start: 9, end: 20 }
  });
  assert.equal(result.checks.no_guarantee, false);
});

test("threatening language is flagged", () => {
  const result = _test.auditTranscript({
    transcript: [line("assistant", "ASAP Finance. payment nahi kiya to legal action lenge aur police ko bhejenge.")],
    brandName: "ASAP Finance", callHourIst: 12, callWindow: { start: 9, end: 20 }
  });
  assert.equal(result.checks.no_threat, false);
});

test("ignored opt-out is flagged; honored opt-out passes", () => {
  const ignored = _test.auditTranscript({
    transcript: [line("assistant", "ASAP Finance."), line("user", "please do not call me again"), line("assistant", "ठीक है आगे बढ़ते हैं")],
    outcome: "IN_PROGRESS", brandName: "ASAP Finance", callHourIst: 12, callWindow: { start: 9, end: 20 }
  });
  assert.equal(ignored.checks.opt_out_honored, false);

  const honored = _test.auditTranscript({
    transcript: [line("assistant", "ASAP Finance."), line("user", "do not call me again"), line("assistant", "समझ गया, धन्यवाद")],
    outcome: "OPTED_OUT", brandName: "ASAP Finance", callHourIst: 12, callWindow: { start: 9, end: 20 }
  });
  assert.equal(honored.checks.opt_out_honored, true);
});

test("calling outside the permitted window is flagged", () => {
  const result = _test.auditTranscript({
    transcript: [line("assistant", "ASAP Finance से call है।")],
    brandName: "ASAP Finance", callHourIst: 22, callWindow: { start: 9, end: 20 }
  });
  assert.equal(result.checks.calling_window, false);
});

test("missing disclosure (brand never spoken) is flagged", () => {
  const result = _test.auditTranscript({
    transcript: [line("assistant", "Hello, is this the right person?"), line("user", "yes")],
    brandName: "ASAP Finance", callHourIst: 12, callWindow: { start: 9, end: 20 }
  });
  assert.equal(result.checks.disclosure_present, false);
});
