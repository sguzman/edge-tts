(function attachPronunciationDefaults(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.EdgeTtsPronunciationDefaults = api;
})(globalThis, function createPronunciationDefaults() {
  const STORAGE_KEY = "edgeTtsPronunciationConfigV1";

  const LETTER_SOUNDS = {
    A: "ay", B: "bee", C: "see", D: "dee", E: "ee", F: "eff",
    G: "jee", H: "aitch", I: "eye", J: "jay", K: "kay", L: "el",
    M: "em", N: "en", O: "oh", P: "pee", Q: "cue", R: "ar",
    S: "ess", T: "tee", U: "you", V: "vee", W: "double you",
    X: "ex", Y: "why", Z: "zee",
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine"
  };

  const DEFAULT_CONFIG = {
    schemaVersion: 1,
    enabled: true,
    normalization: {
      collapseWhitespace: true,
      removeSpaceBeforePunctuation: true,
      stripInlineCode: true,
      stripMarkdownLinks: true,
      dropNumericBracketCitations: true,
      dropParentheticalNumericCitations: true,
      dropSuperscriptCitations: true,
      dropWordSuffixNumericFootnotes: true,
      dropSquareBracketText: true,
      dropCurlyBraceText: true,
      minSentenceChars: 2,
      requireAlphanumeric: true,
      dropTokens: [],
      replacements: {
        "#": " ",
        "*": " ",
        ":": " ",
        "%": " percent "
      }
    },
    technical: {
      expandFilesystemPaths: true,
      expandShellFlags: true,
      pauseBetweenPathComponents: true,
      pathWords: {
        "~": "home directory",
        "/": "slash",
        ".": "dot",
        "_": "underscore",
        "-": "dash"
      }
    },
    abbreviations: {
      nocase: {
        "chap.": "chapter",
        "sect.": "section",
        "Calif.": "California"
      },
      case: {
        "chap.": "chapter",
        "ch.": "chapter",
        "e.g.": "for example",
        "ed.": "edition",
        "esp.": "especially",
        "etc.": "et cetera",
        "i.e.": "that is",
        "ibid.": "in the same place",
        "Ibid": "in the same place",
        "no.": "number",
        "p.": "page",
        "pp.": "pages",
        "rev.": "revised",
        "sect.": "section",
        "vol.": "volume",
        "vs.": "versus",
        "al.": "all",
        "www.": "w w w dot ",
        "http://www.": "h t t p w w w dot ",
        "https://www.": "h t t p s w w w dot ",
        "ftp.": "f t p dot ",
        "mailto:": "mail to ",
        "II": "the second",
        "III": "the third",
        "IV": "the fourth",
        "V": "the fifth",
        "VI": "the sixth",
        "Jr.": "Junior",
        "Sr.": "Senior",
        "Dr.": "Doctor",
        "Inc.": "Incorporated",
        "Mr.": "Mister",
        "Ms.": "Miss",
        "Mrs.": "Misses",
        "St.": "Saint",
        "Gov.": "Governor",
        "Pres.": "President",
        "Sen.": "Senator",
        "Rep.": "Representative",
        "AM": "A M",
        "PM": "P M",
        "a.m.": "A M",
        "p.m.": "P M",
        "Jan.": "January",
        "Feb.": "February",
        "Mar.": "March",
        "Apr.": "April",
        "Jun.": "June",
        "Jul.": "July",
        "Aug.": "August",
        "Sep.": "September",
        "Oct.": "October",
        "Nov.": "November",
        "Dec.": "December",
        "Mon.": "Monday",
        "Tue.": "Tuesday",
        "Wed.": "Wednesday",
        "Thu.": "Thursday",
        "Fri.": "Friday",
        "Sat.": "Saturday",
        "Sun.": "Sunday",
        "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
        "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
        "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
        "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
        "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
        "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
        "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
        "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
        "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
        "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
        "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee",
        "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
        "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
        "Ala.": "Alabama", "Calif.": "California", "Mass.": "Massachusetts",
        "Va.": "Virginia", "N.J.": "New Jersey", "Ind.": "Indiana",
        "Kans.": "Kansas", "Md.": "Maryland",
        "A.": "A", "B.": "B", "C.": "C", "D.": "D", "E.": "E", "F.": "F",
        "G.": "G", "H.": "H", "I.": "I", "J.": "J", "K.": "K", "L.": "L",
        "M.": "M", "N.": "N", "O.": "O", "P.": "P", "Q.": "Q", "R.": "R",
        "S.": "S", "T.": "T", "U.": "U", "V.": "V", "W.": "W", "X.": "X",
        "Y.": "Y", "Z.": "Z",
        "Gen.": "Genesis", "Exod.": "Exodus", "Lev.": "Leviticus",
        "Num.": "Numbers", "Deut.": "Deuteronomy", "Judg.": "Judges",
        "Phil.": "Philemon", "Eph.": "Ephesians", "Rom.": "Romans"
      },
      regex: [
        { pattern: "\\bp\\.\\s*(\\d+)\\.?", replace: "page $1", caseSensitive: true },
        { pattern: "\\b(\\d+)-(\\d+)\\b", replace: "$1 to $2", caseSensitive: true },
        { pattern: "\\b(\\d+)\\.(\\d+)\\b", replace: "$1 dot $2", caseSensitive: true },
        { pattern: "\\b([A-Za-z0-9-]+)\\.(net|com|gov|org|uk|mx|cn|de|ru|br)\\b", replace: "$1 dot $2", caseSensitive: false },
        { pattern: "\\b([A-Za-z0-9_][A-Za-z0-9_.-]*)\\.(txt|md|html|pdf|epub)\\b", replace: "$1 dot $2", caseSensitive: false }
      ]
    },
    acronyms: {
      enabled: true,
      tokens: ["CSS","HTML","HTTP","HTTPS","URL","API","CPU","GPU","JSON","SQL","XML","TTS","XTTS","LLM"],
      letterSeparator: " ",
      digitSeparator: " point ",
      letterSounds: LETTER_SOUNDS
    },
    pronunciation: {
      yearMode: "american",
      numberSeparator: " ",
      insertAnd: false,
      enableBrandMap: true,
      brandMap: {
        MySQL: "My S Q L",
        Mysql: "My S Q L",
        SQLite: "S Q Lite",
        SQLITE: "S Q Lite",
        PostCSS: "Post C S S"
      },
      customPronunciations: {
        Cato: "Kay toe",
        Plato: "Play toe",
        Calhoun: "Cahl Hoon",
        Byrd: "bird",
        fentanyl: "fenta nill",
        hippies: "hip peas",
        Fauci: "Fau chi",
        Chiapas: "Chi a paz",
        Oaxaca: "O a ha ka",
        readlink: "read link"
      }
    }
  };

  function cloneDefaultConfig() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  return { STORAGE_KEY, DEFAULT_CONFIG, cloneDefaultConfig };
});
