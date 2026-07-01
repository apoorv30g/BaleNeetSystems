const test = require("node:test");
const assert = require("node:assert/strict");
const { expandCurrencyForSpeech } = require("../src/services/speechText");

test("currency expands 1800 into spoken Indian English", () => {
  assert.equal(
    expandCurrencyForSpeech("Your offer is ₹1,800.", "English"),
    "Your offer is one thousand eight hundred rupees."
  );
});

test("currency expands 1800 into spoken Hindi", () => {
  assert.equal(
    expandCurrencyForSpeech("आपका offer ₹1,800 है।", "Hindi"),
    "आपका offer एक हज़ार आठ सौ रुपये है।"
  );
});

test("currency uses lakh grouping for larger loan amounts", () => {
  assert.equal(
    expandCurrencyForSpeech("INR 125000", "English"),
    "one lakh twenty five thousand rupees"
  );
});
