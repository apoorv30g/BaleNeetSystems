const ENGLISH_SMALL = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"
];
const ENGLISH_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const HINDI_SMALL = [
  "शून्य", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ",
  "दस", "ग्यारह", "बारह", "तेरह", "चौदह", "पंद्रह", "सोलह", "सत्रह", "अठारह", "उन्नीस",
  "बीस", "इक्कीस", "बाईस", "तेईस", "चौबीस", "पच्चीस", "छब्बीस", "सत्ताईस", "अट्ठाईस", "उनतीस",
  "तीस", "इकतीस", "बत्तीस", "तैंतीस", "चौंतीस", "पैंतीस", "छत्तीस", "सैंतीस", "अड़तीस", "उनतालीस",
  "चालीस", "इकतालीस", "बयालीस", "तैंतालीस", "चवालीस", "पैंतालीस", "छियालीस", "सैंतालीस", "अड़तालीस", "उनचास",
  "पचास", "इक्यावन", "बावन", "तिरपन", "चौवन", "पचपन", "छप्पन", "सत्तावन", "अट्ठावन", "उनसठ",
  "साठ", "इकसठ", "बासठ", "तिरसठ", "चौंसठ", "पैंसठ", "छियासठ", "सड़सठ", "अड़सठ", "उनहत्तर",
  "सत्तर", "इकहत्तर", "बहत्तर", "तिहत्तर", "चौहत्तर", "पचहत्तर", "छिहत्तर", "सतहत्तर", "अठहत्तर", "उनासी",
  "अस्सी", "इक्यासी", "बयासी", "तिरासी", "चौरासी", "पचासी", "छियासी", "सत्तासी", "अट्ठासी", "नवासी",
  "नब्बे", "इक्यानवे", "बानवे", "तिरानवे", "चौरानवे", "पंचानवे", "छियानवे", "सत्तानवे", "अट्ठानवे", "निन्यानवे"
];

function expandCurrencyForSpeech(text, language = "Hindi") {
  const english = String(language || "").toLowerCase().includes("english");
  return String(text || "").replace(/(?:₹|\b(?:rs\.?|inr)\s*)\s*([\d,]+(?:\.\d{1,2})?)/gi, (match, rawAmount) => {
    const amount = Number(String(rawAmount).replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) return match;
    return currencyWords(amount, english);
  });
}

function currencyWords(amount, english) {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  if (english) {
    const main = `${integerToIndianEnglish(rupees)} ${rupees === 1 ? "rupee" : "rupees"}`;
    return paise ? `${main} and ${integerToIndianEnglish(paise)} paise` : main;
  }
  const main = `${integerToIndianHindi(rupees)} रुपये`;
  return paise ? `${main} और ${integerToIndianHindi(paise)} पैसे` : main;
}

function integerToIndianEnglish(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) return String(value);
  if (number < 20) return ENGLISH_SMALL[number];
  if (number < 100) {
    const remainder = number % 10;
    return `${ENGLISH_TENS[Math.floor(number / 10)]}${remainder ? ` ${ENGLISH_SMALL[remainder]}` : ""}`;
  }
  return joinIndianNumber(number, integerToIndianEnglish, {
    crore: "crore", lakh: "lakh", thousand: "thousand", hundred: "hundred"
  });
}

function integerToIndianHindi(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) return String(value);
  if (number < 100) return HINDI_SMALL[number];
  return joinIndianNumber(number, integerToIndianHindi, {
    crore: "करोड़", lakh: "लाख", thousand: "हज़ार", hundred: "सौ"
  });
}

function joinIndianNumber(number, formatter, units) {
  const parts = [];
  let remainder = number;
  for (const [size, label] of [
    [10000000, units.crore], [100000, units.lakh], [1000, units.thousand], [100, units.hundred]
  ]) {
    const count = Math.floor(remainder / size);
    if (!count) continue;
    parts.push(`${formatter(count)} ${label}`);
    remainder %= size;
  }
  if (remainder) parts.push(formatter(remainder));
  return parts.join(" ");
}

module.exports = { expandCurrencyForSpeech, integerToIndianEnglish, integerToIndianHindi };
