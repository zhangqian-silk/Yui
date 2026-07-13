import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import {
  DEFAULT_INERT_DATA_LIMITS,
  createInertDataArray,
  createInertDataLimits,
  createInertDataObject,
  createInertDataSnapshot,
  digestInertDataSnapshot,
  encodeCanonicalInertData,
  parseCanonicalInertData,
  stringifyCanonicalInertData
} from "../dist/storage/inertData.js";

function inertArray(items, limits) {
  const value = createInertDataArray(items, limits);
  assert.ok(value);
  return value;
}

function inertObject(entries, limits) {
  const value = createInertDataObject(entries, limits);
  assert.ok(value);
  return value;
}

function snapshot(value, limits) {
  const result = createInertDataSnapshot(value, limits);
  assert.ok(result);
  return result;
}

test("builders produce branded frozen data with code-unit canonical bytes and digest", () => {
  const first = snapshot(inertObject([
    ["\u00e9", "nfc"],
    ["a", inertArray([true, null, 2])],
    ["e\u0301", "nfd"]
  ]));
  const second = snapshot(inertObject([
    ["e\u0301", "nfd"],
    ["a", inertArray([true, null, 2])],
    ["\u00e9", "nfc"]
  ]));

  assert.equal(Object.getPrototypeOf(first), null);
  assert.equal(Object.getPrototypeOf(first.value), null);
  assert.equal(Object.getPrototypeOf(first.value.a), null);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.a), true);

  const json = stringifyCanonicalInertData(first);
  const bytes = encodeCanonicalInertData(first);
  const digest = digestInertDataSnapshot(first);
  assert.equal(json, '{"a":[true,null,2],"e\u0301":"nfd","\u00e9":"nfc"}');
  assert.deepEqual(bytes, Buffer.from(json, "utf8"));
  assert.equal(first.encodedByteLength, bytes.byteLength);
  assert.equal(digest, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(json, stringifyCanonicalInertData(second));
  assert.equal(digest, digestInertDataSnapshot(second));
  assert.equal(
    stringifyCanonicalInertData(snapshot(inertObject([["a", 1], ["Z", 2]]))),
    '{"Z":2,"a":1}'
  );
  assert.notEqual(
    digestInertDataSnapshot(snapshot("\u00e9")),
    digestInertDataSnapshot(snapshot("e\u0301"))
  );
});

test("opaque snapshots safely re-encode, parse, and re-digest nested arrays", () => {
  const original = snapshot(inertObject([
    ["nested", inertArray([inertArray(["value"])])]
  ]));
  const digest = digestInertDataSnapshot(original);
  const bytes = encodeCanonicalInertData(original);
  bytes[0] = 0;
  assert.equal(encodeCanonicalInertData(original)[0], 0x7b, "callers receive a fresh byte copy");

  const parsed = parseCanonicalInertData(encodeCanonicalInertData(original));
  assert.ok(parsed);
  assert.equal(digestInertDataSnapshot(parsed), digest);
  assert.equal(stringifyCanonicalInertData(parsed), '{"nested":[["value"]]}');

  const forged = Object.freeze(Object.assign(Object.create(null), {
    value: original.value,
    encodedByteLength: original.encodedByteLength
  }));
  assert.equal(stringifyCanonicalInertData(forged), null);
  assert.equal(encodeCanonicalInertData(forged), null);
  assert.equal(digestInertDataSnapshot(forged), null);
});

test("authority snapshots reject every unbranded container and prototype-spoofed exotic", () => {
  const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const values = [
    {},
    [],
    Object.create(null),
    Object.setPrototypeOf(new WeakRef({}), Object.prototype),
    Object.setPrototypeOf(new FinalizationRegistry(() => undefined), Object.prototype),
    Object.setPrototypeOf(new URL("https://example.com"), Object.prototype),
    Object.setPrototypeOf(new URLSearchParams("a=1"), Object.prototype),
    Object.setPrototypeOf(new AbortController(), Object.prototype),
    Object.setPrototypeOf(wasm, Object.prototype),
    Object.setPrototypeOf(new Intl.DateTimeFormat("en"), Object.prototype),
    new Date(0),
    new Map(),
    new Set(),
    /unsafe/,
    new Uint8Array([1]),
    new Number(1)
  ];
  for (let index = 0; index < values.length; index += 1) {
    assert.equal(createInertDataSnapshot(values[index]), null);
  }
  for (const value of [undefined, -0, NaN, Infinity, 1n, Symbol("x"), () => undefined]) {
    assert.equal(createInertDataSnapshot(value), null);
  }
});

test("builder envelopes are descriptor-safe and never invoke getters or proxies", () => {
  let calls = 0;
  const accessorItems = [1];
  Object.defineProperty(accessorItems, "0", {
    enumerable: true,
    get() {
      calls += 1;
      throw new Error("must not execute");
    }
  });
  assert.equal(createInertDataArray(accessorItems), null);

  const proxyEntry = new Proxy(["key", "value"], {
    get() {
      calls += 1;
      throw new Error("must not execute");
    },
    getOwnPropertyDescriptor() {
      calls += 1;
      throw new Error("must not execute");
    },
    getPrototypeOf() {
      calls += 1;
      throw new Error("must not execute");
    },
    ownKeys() {
      calls += 1;
      throw new Error("must not execute");
    }
  });
  assert.equal(createInertDataObject([proxyEntry]), null);
  assert.equal(calls, 0);

  const prototypeProxy = new Proxy({}, {
    get() { calls += 1; throw new Error("must not execute"); },
    getOwnPropertyDescriptor() { calls += 1; throw new Error("must not execute"); },
    getPrototypeOf() { calls += 1; throw new Error("must not execute"); },
    isExtensible() { calls += 1; throw new Error("must not execute"); },
    ownKeys() { calls += 1; throw new Error("must not execute"); }
  });
  const exotic = Object.create(prototypeProxy);
  exotic.value = 1;
  assert.equal(createInertDataSnapshot(exotic), null);
  assert.equal(calls, 0);
});

test("authority construction never reads polluted PropertyDescriptor prototypes", () => {
  const originalGet = Object.getOwnPropertyDescriptor(Object.prototype, "get");
  const originalSet = Object.getOwnPropertyDescriptor(Object.prototype, "set");
  const getDescriptor = Object.assign(Object.create(null), {
    configurable: true,
    get() {
      calls += 1;
      throw new Error("must not execute");
    }
  });
  const setDescriptor = Object.assign(Object.create(null), {
    configurable: true,
    get() {
      calls += 1;
      throw new Error("must not execute");
    }
  });
  let calls = 0;
  let limits;
  let array;
  let object;
  let valueSnapshot;
  let parsed;
  try {
    Object.defineProperty(Object.prototype, "get", getDescriptor);
    Object.defineProperty(Object.prototype, "set", setDescriptor);
    limits = createInertDataLimits(2, 10, 10, 10, 100, 1000);
    array = createInertDataArray([true], limits);
    object = createInertDataObject([["safe", array]], limits);
    valueSnapshot = createInertDataSnapshot(object, limits);
    parsed = parseCanonicalInertData(Buffer.from('{"safe":[true]}'), limits);
  } finally {
    delete Object.prototype.get;
    delete Object.prototype.set;
    restoreDescriptor(Object.prototype, "get", originalGet);
    restoreDescriptor(Object.prototype, "set", originalSet);
  }
  assert.equal(calls, 0);
  assert.ok(limits);
  assert.ok(array);
  assert.ok(object);
  assert.ok(valueSnapshot);
  assert.ok(parsed);
});

test("builders reject holes, extras, symbols, duplicates, accessors, and unbranded children", () => {
  const symbolItems = [1];
  symbolItems[Symbol("extra")] = true;
  const extraItems = [1];
  extraItems.extra = true;
  assert.equal(createInertDataArray([1, , 3]), null);
  assert.equal(createInertDataArray(symbolItems), null);
  assert.equal(createInertDataArray(extraItems), null);
  assert.equal(createInertDataArray([undefined]), null);
  assert.equal(createInertDataArray([{}]), null);
  assert.equal(createInertDataObject([["same", 1], ["same", 2]]), null);
  assert.equal(createInertDataObject([["bad", {}]]), null);
  assert.equal(createInertDataObject([[Symbol("bad"), 1]]), null);

  const entry = ["key", 1];
  entry.extra = true;
  assert.equal(createInertDataObject([entry]), null);
  const shared = inertObject([["value", 1]]);
  assert.ok(createInertDataObject([["left", shared], ["right", shared]]));
});

test("canonical encoding ignores toJSON, iterators, and numeric-index prototype pollution", () => {
  const value = inertObject([["z", inertArray([1])], ["a", "ok"]]);
  const builderEntries = [["safe", true]];
  const canonicalInput = Buffer.from('{"safe":true}');
  const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const zero = Object.getOwnPropertyDescriptor(Array.prototype, "0");
  let calls = 0;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    get() { calls += 1; throw new Error("must not execute"); }
  });
  Object.defineProperty(Array.prototype, "toJSON", {
    configurable: true,
    value() { calls += 1; throw new Error("must not execute"); }
  });
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    configurable: true,
    get() { calls += 1; throw new Error("must not execute"); }
  });
  Object.defineProperty(Array.prototype, "0", {
    configurable: true,
    set(token) {
      calls += 1;
      Object.defineProperty(this, "0", {
        configurable: true,
        enumerable: true,
        value: token === "true" ? "null" : token,
        writable: true
      });
    }
  });

  let encoded;
  let trueDigest;
  let nullDigest;
  let built;
  let parsed;
  try {
    built = createInertDataObject(builderEntries);
    const valueSnapshot = createInertDataSnapshot(value);
    const trueSnapshot = createInertDataSnapshot(true);
    const nullSnapshot = createInertDataSnapshot(null);
    parsed = parseCanonicalInertData(canonicalInput);
    encoded = stringifyCanonicalInertData(valueSnapshot);
    trueDigest = digestInertDataSnapshot(trueSnapshot);
    nullDigest = digestInertDataSnapshot(nullSnapshot);
  } finally {
    restoreDescriptor(Object.prototype, "toJSON", objectToJson);
    restoreDescriptor(Array.prototype, "toJSON", arrayToJson);
    restoreDescriptor(Array.prototype, Symbol.iterator, iterator);
    restoreDescriptor(Array.prototype, "0", zero);
  }
  assert.equal(encoded, '{"a":"ok","z":[1]}');
  assert.ok(built);
  assert.ok(parsed);
  assert.notEqual(trueDigest, nullDigest);
  assert.equal(calls, 0);
});

test("digest and byte accounting ignore mutable crypto and TypedArray prototypes", () => {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const originalByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength");
  const originalCreateHash = crypto.createHash;
  const hashPrototype = Object.getPrototypeOf(originalCreateHash("sha256"));
  const originalHashUpdate = Object.getOwnPropertyDescriptor(hashPrototype, "update");
  const originalHashDigest = Object.getOwnPropertyDescriptor(hashPrototype, "digest");
  const canonicalTrue = Buffer.from("true");
  let getterCalls = 0;
  let mutableHashCalls = 0;
  let trueDigest;
  let nullDigest;
  let encoded;
  let parsed;
  try {
    crypto.createHash = () => ({
      update() { return this; },
      digest() { return "attacker-controlled-digest"; }
    });
    syncBuiltinESMExports();
    Object.defineProperty(hashPrototype, "update", {
      configurable: true,
      value() {
        mutableHashCalls += 1;
        throw new Error("must not execute");
      }
    });
    Object.defineProperty(hashPrototype, "digest", {
      configurable: true,
      value() {
        mutableHashCalls += 1;
        throw new Error("must not execute");
      }
    });
    Object.defineProperty(typedArrayPrototype, "byteLength", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not execute");
      }
    });
    trueDigest = digestInertDataSnapshot(createInertDataSnapshot(true));
    nullDigest = digestInertDataSnapshot(createInertDataSnapshot(null));
    encoded = encodeCanonicalInertData(createInertDataSnapshot(true));
    parsed = parseCanonicalInertData(canonicalTrue);
  } finally {
    crypto.createHash = originalCreateHash;
    syncBuiltinESMExports();
    restoreDescriptor(hashPrototype, "update", originalHashUpdate);
    restoreDescriptor(hashPrototype, "digest", originalHashDigest);
    restoreDescriptor(typedArrayPrototype, "byteLength", originalByteLength);
  }
  assert.equal(getterCalls, 0);
  assert.equal(mutableHashCalls, 0);
  assert.notEqual(trueDigest, nullDigest);
  assert.deepEqual(encoded, Buffer.from("true"));
  assert.ok(parsed);
});

test("opaque lowering-only limits enforce every exact budget boundary", () => {
  assert.equal(DEFAULT_INERT_DATA_LIMITS.maxDepth, 64);
  assert.equal(DEFAULT_INERT_DATA_LIMITS.maxNodes, 100_000);
  assert.equal(DEFAULT_INERT_DATA_LIMITS.maxArrayLength, 10_000);
  assert.equal(DEFAULT_INERT_DATA_LIMITS.maxObjectKeys, 10_000);
  assert.equal(DEFAULT_INERT_DATA_LIMITS.maxStringBytes, 1_048_576);
  assert.equal(DEFAULT_INERT_DATA_LIMITS.maxTotalEncodedBytes, 8_388_608);
  assert.equal(Object.getPrototypeOf(DEFAULT_INERT_DATA_LIMITS), null);
  assert.equal(Object.isFrozen(DEFAULT_INERT_DATA_LIMITS), true);

  const limits = createInertDataLimits(1, 2, 2, 2, 2, 10);
  assert.ok(limits);
  assert.ok(createInertDataSnapshot(inertObject([["a", true]]), limits));
  assert.equal(createInertDataSnapshot(inertObject([["a", inertObject([])]]), limits), null);
  assert.equal(createInertDataSnapshot(inertObject([["a", true], ["b", false]]), limits), null);
  assert.equal(createInertDataArray([1, 2, 3], limits), null);
  assert.equal(createInertDataObject([["a", 1], ["b", 2], ["c", 3]], limits), null);
  assert.ok(createInertDataSnapshot("\u00e9", limits));
  assert.equal(createInertDataSnapshot("e\u0301", limits), null);
  assert.equal(createInertDataSnapshot(inertObject([["a", "bbb"]]), limits), null);

  assert.equal(createInertDataLimits(-1, 1, 1, 1, 1, 1), null);
  assert.equal(createInertDataLimits(1.5, 1, 1, 1, 1, 1), null);
  assert.equal(createInertDataLimits(65, 1, 1, 1, 1, 1), null);
  assert.equal(createInertDataSnapshot(true, {}), null);

  const noContainerDepth = createInertDataLimits(0, 10, 10, 10, 100, 1000);
  const noNodes = createInertDataLimits(10, 0, 10, 10, 100, 1000);
  const threeBytes = createInertDataLimits(10, 10, 10, 10, 100, 3);
  const sixBytes = createInertDataLimits(10, 10, 10, 10, 100, 6);
  assert.ok(noContainerDepth);
  assert.ok(noNodes);
  assert.ok(threeBytes);
  assert.ok(sixBytes);
  assert.equal(createInertDataArray([], noContainerDepth), null);
  assert.equal(createInertDataObject([], noContainerDepth), null);
  assert.equal(createInertDataArray([], noNodes), null);
  assert.equal(createInertDataObject([], noNodes), null);
  assert.equal(createInertDataArray([true], threeBytes), null);
  assert.equal(createInertDataObject([["long", true]], threeBytes), null);
  assert.ok(createInertDataArray([true], sixBytes));
});

test("private container metrics price DAG expansion and descendant limits before allocation", () => {
  const leaf = inertObject([["x", true]]);
  const exactDag = createInertDataLimits(2, 5, 2, 1, 1, 23);
  const shallow = createInertDataLimits(1, 5, 2, 1, 1, 23);
  const tooFewNodes = createInertDataLimits(2, 4, 2, 1, 1, 23);
  const tooFewBytes = createInertDataLimits(2, 5, 2, 1, 1, 22);
  const noDescendantObjects = createInertDataLimits(2, 5, 2, 0, 1, 23);
  const noDescendantStrings = createInertDataLimits(2, 5, 2, 1, 0, 23);
  const exactArray = createInertDataArray([leaf, leaf], exactDag);
  assert.ok(exactArray);
  assert.ok(createInertDataSnapshot(exactArray, exactDag));
  assert.equal(createInertDataArray([leaf, leaf], shallow), null);
  assert.equal(createInertDataArray([leaf, leaf], tooFewNodes), null);
  assert.equal(createInertDataArray([leaf, leaf], tooFewBytes), null);
  assert.equal(createInertDataArray([leaf, leaf], noDescendantObjects), null);
  assert.equal(createInertDataArray([leaf, leaf], noDescendantStrings), null);

  const exactUnicodeObject = createInertDataLimits(1, 2, 1, 1, 2, 11);
  const shortUnicodeObject = createInertDataLimits(1, 2, 1, 1, 2, 10);
  const narrowUnicodeString = createInertDataLimits(1, 2, 1, 1, 1, 11);
  const unicodeObject = createInertDataObject([["é", true]], exactUnicodeObject);
  assert.ok(unicodeObject);
  assert.ok(createInertDataSnapshot(unicodeObject, exactUnicodeObject));
  assert.equal(createInertDataObject([["é", true]], shortUnicodeObject), null);
  assert.equal(createInertDataObject([["é", true]], narrowUnicodeString), null);

  const parsedLeaf = parseCanonicalInertData(Buffer.from('{"x":true}'));
  assert.ok(parsedLeaf);
  const parsedDag = createInertDataArray([parsedLeaf.value, parsedLeaf.value], exactDag);
  assert.ok(parsedDag, "parser-created containers carry the same private metrics authority");
  assert.ok(createInertDataSnapshot(parsedDag, exactDag));
});

test("strict parser accepts only canonical fatal UTF-8 JSON with unique sorted keys", () => {
  const canonical = Buffer.from('{"a":[true,null,2],"e\u0301":"nfd","\u00e9":"nfc"}');
  const parsed = parseCanonicalInertData(canonical);
  assert.ok(parsed);
  assert.deepEqual(encodeCanonicalInertData(parsed), canonical);
  assert.equal(Object.getPrototypeOf(parsed.value), null);
  assert.equal(Object.getPrototypeOf(parsed.value.a), null);
  assert.equal(Object.isFrozen(parsed.value), true);
  assert.equal(Object.isFrozen(parsed.value.a), true);

  const invalid = [
    Buffer.from([0xff]),
    Buffer.from([0xef, 0xbb, 0xbf, 0x74, 0x72, 0x75, 0x65]),
    Buffer.from(""),
    Buffer.from(" true"),
    Buffer.from("true "),
    Buffer.from('{"b":1,"a":2}'),
    Buffer.from('{"a":1,"a":2}'),
    Buffer.from('{"a":1.0}'),
    Buffer.from('{"a":1e0}'),
    Buffer.from('-0'),
    Buffer.from('"\\/"'),
    Buffer.from('"\\u00E9"'),
    Buffer.from('"\\u00e9"'),
    Buffer.from('"\\u0008"'),
    Buffer.from('"\\u0022"'),
    Buffer.from('"\\u005c"'),
    Buffer.from('"\\u007f"'),
    Buffer.from('"\ud83d\ude00"', "utf8"),
    Buffer.from("1e-6"),
    Buffer.from("1".repeat(100_000)),
    Buffer.from('{"a":undefined}')
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    assert.equal(parseCanonicalInertData(invalid[index]), null);
  }
  assert.ok(parseCanonicalInertData(Buffer.from('"\\ud83d\\ude00"')));
  assert.ok(parseCanonicalInertData(Buffer.from('"\\ud800"')));
  assert.ok(parseCanonicalInertData(Buffer.from('"\\u001f"')));
  assert.ok(parseCanonicalInertData(Buffer.from('"\\b\\t\\n\\f\\r"')));
  assert.ok(parseCanonicalInertData(Buffer.from('"/"')));
  assert.ok(parseCanonicalInertData(Buffer.from("1e+21")));
  assert.ok(parseCanonicalInertData(Buffer.from("0.000001")));
});

test("strict parser checks byte authority before copying and ignores typed-array prototypes", () => {
  assert.equal(
    parseCanonicalInertData(new Uint8Array(MAX_TEST_FRAME_BYTES + 1)),
    null
  );
  assert.equal(parseCanonicalInertData(new Uint8Array(new SharedArrayBuffer(4))), null);

  let traps = 0;
  const prototype = new Proxy({}, {
    get() { traps += 1; throw new Error("must not execute"); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error("must not execute"); },
    getPrototypeOf() { traps += 1; throw new Error("must not execute"); },
    ownKeys() { traps += 1; throw new Error("must not execute"); }
  });
  const bytes = new Uint8Array(Buffer.from("true"));
  Object.setPrototypeOf(bytes, prototype);
  assert.ok(parseCanonicalInertData(bytes));
  assert.equal(traps, 0);

  const proxy = new Proxy(new Uint8Array(Buffer.from("true")), {
    get() { traps += 1; throw new Error("must not execute"); },
    getPrototypeOf() { traps += 1; throw new Error("must not execute"); }
  });
  assert.equal(parseCanonicalInertData(proxy), null);
  assert.equal(traps, 0);
});

test("strict parser applies collection, depth, node, string, and frame budgets", () => {
  const limits = createInertDataLimits(1, 2, 2, 2, 2, 10);
  assert.ok(limits);
  assert.ok(parseCanonicalInertData(Buffer.from('{"a":true}'), limits));
  assert.equal(parseCanonicalInertData(Buffer.from('{"a":{}}'), limits), null);
  assert.equal(parseCanonicalInertData(Buffer.from('[1,2,3]'), limits), null);
  assert.equal(parseCanonicalInertData(Buffer.from('{"a":1,"b":2,"c":3}'), limits), null);
  assert.equal(parseCanonicalInertData(Buffer.from('"e\u0301"'), limits), null);
  assert.equal(parseCanonicalInertData(Buffer.from('{"a":"bbb"}'), limits), null);
  assert.equal(parseCanonicalInertData(Buffer.from('{"a":false}'), limits), null);
});

test("strict parser bounds escape-heavy strings and rejects semantic bytes at the exact limit", () => {
  const limit = 4096;
  const limits = createInertDataLimits(1, 1, 1, 1, limit, 30_000);
  assert.ok(limits);
  const exactControls = Buffer.from('"' + "\\u0000".repeat(limit) + '"');
  const excessiveControls = Buffer.from('"' + "\\u0000".repeat(limit + 1) + '"');
  const exactSurrogatePairs = Buffer.from('"' + "\\ud83d\\ude00".repeat(limit / 4) + '"');
  const excessiveLowSurrogates = Buffer.from('"' + "\\udc00".repeat(Math.floor(limit / 3) + 1) + '"');
  assert.ok(parseCanonicalInertData(exactControls, limits));
  assert.equal(parseCanonicalInertData(excessiveControls, limits), null);
  assert.ok(parseCanonicalInertData(exactSurrogatePairs, limits));
  assert.equal(parseCanonicalInertData(excessiveLowSurrogates, limits), null);
});

test("strict parser captures its validated string decoder before mutable JSON pollution", () => {
  const originalParse = JSON.parse;
  let calls = 0;
  let parsed;
  try {
    JSON.parse = () => {
      calls += 1;
      throw new Error("must not execute");
    };
    parsed = parseCanonicalInertData(Buffer.from('"\\u0000\\ud83d\\ude00"'));
  } finally {
    JSON.parse = originalParse;
  }
  assert.equal(calls, 0);
  assert.ok(parsed);
  assert.equal(parsed.value, "\u0000😀");
});

test("canonical strings preserve controls, lone surrogates, and UTF-8 identity", () => {
  const loneHigh = snapshot("\ud800");
  const replacement = snapshot("\ufffd");
  const controls = snapshot("\b\t\n\f\r\u0000\"\\");
  const emojiLimits = createInertDataLimits(64, 100, 100, 100, 4, 14);
  const emoji = snapshot("\ud83d\ude00", emojiLimits);

  assert.equal(stringifyCanonicalInertData(loneHigh), '"\\ud800"');
  assert.notEqual(digestInertDataSnapshot(loneHigh), digestInertDataSnapshot(replacement));
  assert.equal(stringifyCanonicalInertData(controls), '"\\b\\t\\n\\f\\r\\u0000\\\"\\\\"');
  assert.deepEqual(JSON.parse(stringifyCanonicalInertData(controls)), "\b\t\n\f\r\u0000\"\\");
  assert.equal(stringifyCanonicalInertData(emoji), '"\\ud83d\\ude00"');
});

function restoreDescriptor(target, key, descriptor) {
  if (descriptor === undefined) delete target[key];
  else Object.defineProperty(target, key, descriptor);
}

const MAX_TEST_FRAME_BYTES = 8_388_608;
