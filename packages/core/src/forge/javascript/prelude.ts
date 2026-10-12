/**
 * The prelude: the JavaScript the guest VM evaluates before the model's code (spec §6.2, D-26). It
 * installs the API globals (`tools`, `catalog`, `state`, `text`, `progress`, `parallel`, `console`,
 * `callTool`), removes what a script must not reach and hands the isolate runner two functions.
 *
 * What it does and does not guarantee:
 *  - It captures the intrinsics it uses (the Array, String and Promise methods too, called through
 *    `uncurry`, so a script that rewrites a prototype cannot change what the API does), takes the
 *    bridge callback into a closure and deletes it from `globalThis`, freezes its API objects and
 *    removes `SharedArrayBuffer` and `InternalError`.
 *  - The script runs in the same VM, so it CAN tamper with the prelude's own state. None of the
 *    security invariants rely on it: credits, concurrency, sizes and the protocol are enforced by
 *    the host. What the prelude adds is ergonomics (local, early errors; queueing instead of
 *    failing) and the terminal `fatal` for a spent call budget.
 *  - It talks to the host only through `bridge(kind, jsonString)`; all values cross as JSON text.
 *
 * Erasable TypeScript only (D-33): a string constant, no logic here.
 */
import { PRELUDE_VERSION } from "./runtime-manifest.ts";
import { sha256Hex } from "./wasm.ts";

export const PRELUDE_SOURCE = String.raw`(function (bridge) {
  "use strict";
  var G = globalThis;
  var JSONparse = JSON.parse, JSONstringify = JSON.stringify;
  var ObjectFreeze = Object.freeze, ObjectDefineProperty = Object.defineProperty;
  var ObjectCreate = Object.create, ObjectKeys = Object.keys;
  var ArrayIsArray = Array.isArray;
  var PromiseCtor = Promise;
  var ErrorCtor = Error, TypeErrorCtor = TypeError;
  var StringCtor = String, MathMin = Math.min, MathMax = Math.max;
  var NumberIsInteger = Number.isInteger;
  var ArrayCtor = Array;
  var bindFn = Function.prototype.bind, callFn = Function.prototype.call;
  // uncurry(String.prototype.slice)(text, 0, 5): the captured method, whatever the script does later.
  function uncurry(fn) { return bindFn.call(callFn, fn); }
  var ArrayShift = uncurry(Array.prototype.shift), ArrayJoin = uncurry(Array.prototype.join);
  var StringSlice = uncurry(String.prototype.slice);
  var StringCharCodeAt = uncurry(String.prototype.charCodeAt);
  var StringIndexOf = uncurry(String.prototype.indexOf);
  var PromiseThen = uncurry(Promise.prototype.then);
  var PromiseResolve = bindFn.call(Promise.resolve, Promise);
  var PromiseReject = bindFn.call(Promise.reject, Promise);
  // The engine's own error type (a QuickJS limit). The constructor leaves the global scope so a
  // script cannot build one; only the prototype is kept, to recognise errors the engine raised.
  var ObjectGetPrototypeOf = Object.getPrototypeOf;
  var InternalErrorProto = typeof InternalError === "function" ? InternalError.prototype : undefined;
  var RangeErrorProto = RangeError.prototype;
  // The codes a nested call (or the prelude on its behalf) can legitimately end a script with.
  // Every other code a script writes on an error it throws is just text: SCRIPT_RUNTIME.
  var PASS_CODES = ObjectCreate(null);
  var passList = ["TOOL_UNAVAILABLE", "TOOL_INPUT_INVALID", "TOOL_FAILED", "PERMISSION_DENIED",
    "APPROVAL_REQUIRED", "BUDGET_EXCEEDED", "OUTPUT_LIMIT", "STATE_CONFLICT"];
  for (var p = 0; p < passList.length; p++) PASS_CODES[passList[p]] = true;

  var limits = null;
  var credits = 0, started = 0, nextCallId = 0;
  var waiters = [];
  var state = ObjectCreate(null);
  var consoleBytes = 0, consoleCut = false;
  var CONSOLE_QUOTA = 65536, CHUNK = 60000, MAX_RETURN = 200000;

  function fail(code, message) {
    var e = new ErrorCtor(message);
    e.code = code;
    return e;
  }
  // A terminal condition: tell the host and stop making progress. The host ends the execution.
  function fatal(code, message) {
    bridge("fatal", JSONstringify({ code: code, message: message }));
    return new PromiseCtor(function () {});
  }
  function decodeError(text) {
    var info;
    try { info = JSONparse(text); } catch (e) { info = { code: "TOOL_FAILED", message: StringCtor(text) }; }
    return fail(typeof info.code === "string" ? info.code : "TOOL_FAILED", StringCtor(info.message));
  }
  // UTF-8 size of a JSON text (JSON.stringify leaves no lone surrogate): the host measures bytes.
  function utf8Length(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      var c = StringCharCodeAt(text, i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
        var d = StringCharCodeAt(text, i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
      } else n += 3;
    }
    return n;
  }
  function encode(value, what) {
    var json = JSONstringify(value);
    if (json === undefined) return "null";
    var max = limits.maxCallInputBytes;
    if (json.length > max || (json.length * 3 > max && utf8Length(json) > max))
      throw fail("TOOL_INPUT_INVALID", what + " is larger than " + max + " bytes");
    return json;
  }
  // The registry's naming rule: [a-zA-Z0-9_-]{1,64}.
  function validToolName(name) {
    if (typeof name !== "string" || name.length < 1 || name.length > 64) return false;
    for (var i = 0; i < name.length; i++) {
      var c = StringCharCodeAt(name, i);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45))
        return false;
    }
    return true;
  }

  function acquire() {
    if (started >= limits.maxToolCalls)
      return fatal("BUDGET_EXCEEDED", "Tool call limit reached (" + limits.maxToolCalls + ")");
    if (credits > 0 && waiters.length === 0) {
      credits--;
      started++;
      return PromiseResolve();
    }
    return new PromiseCtor(function (resolve) { waiters[waiters.length] = resolve; });
  }
  function grant(calls) {
    credits += calls;
    while (credits > 0 && waiters.length > 0) {
      if (started >= limits.maxToolCalls) {
        fatal("BUDGET_EXCEEDED", "Tool call limit reached (" + limits.maxToolCalls + ")");
        waiters.length = 0;
        return;
      }
      credits--;
      started++;
      var resume = ArrayShift(waiters);
      resume();
    }
  }

  function toolCall(name, input) {
    if (!validToolName(name))
      return PromiseReject(fail("TOOL_UNAVAILABLE", "tool name must be 1 to 64 characters of letters, digits, _ or -"));
    var json;
    try { json = encode(input === undefined ? {} : input, "tool input"); }
    catch (e) { return PromiseReject(e.code ? e : fail("TOOL_INPUT_INVALID", "tool input must be JSON")); }
    // Built by hand: returning a promise from a then-callback would look then up on it, and the
    // script can replace Promise.prototype.then.
    return new PromiseCtor(function (resolve, reject) {
      PromiseThen(acquire(), function () {
        try {
          var id = ++nextCallId;
          PromiseThen(bridge("call", JSONstringify({ callId: id, tool: name, input: json })), function (text) {
            try { resolve(JSONparse(text)); } catch (e) { reject(e); }
          }, function (error) {
            reject(typeof error === "string" ? decodeError(error) : error);
          });
        } catch (e) { reject(e); }
      }, reject);
    });
  }

  function catalogRequest(op, query, limit) {
    return PromiseThen(bridge("catalog", JSONstringify({ op: op, query: query, limit: limit })),
      function (text) { return JSONparse(text); },
      function (error) { throw typeof error === "string" ? decodeError(error) : error; }
    );
  }

  function pool(items, fn, options, settle) {
    if (!ArrayIsArray(items)) return PromiseReject(new TypeErrorCtor("items must be an array"));
    if (typeof fn !== "function") return PromiseReject(new TypeErrorCtor("fn must be a function"));
    var wanted = options && NumberIsInteger(options.concurrency) ? options.concurrency : limits.maxConcurrency;
    var width = MathMax(1, MathMin(wanted, limits.maxConcurrency, items.length));
    var results = new ArrayCtor(items.length);
    var next = 0, failed = false, firstError;
    function lane() {
      return (async function () {
        while (!failed) {
          var i = next++;
          if (i >= items.length) return;
          try {
            var value = await fn(items[i], i);
            results[i] = settle ? { ok: true, value: value } : value;
          } catch (e) {
            if (settle) {
              results[i] = { ok: false, error: { code: typeof e === "object" && e && typeof e.code === "string" ? e.code : "SCRIPT_RUNTIME", message: StringCtor(e && e.message !== undefined ? e.message : e) } };
            } else if (!failed) {
              failed = true;
              firstError = e;
            }
          }
        }
      })();
    }
    var lanes = [];
    for (var n = 0; n < width; n++) lanes[lanes.length] = lane();
    // Joined by hand: Promise.all would look up Promise.resolve, which the script can replace.
    return new PromiseCtor(function (resolve, reject) {
      var left = lanes.length;
      function one() {
        if (--left > 0) return;
        if (failed) reject(firstError); else resolve(results);
      }
      for (var k = 0; k < lanes.length; k++) PromiseThen(lanes[k], one, one);
    });
  }

  function emitText(value) {
    var text = typeof value === "string" ? value : JSONstringify(value);
    if (text === undefined) text = StringCtor(value);
    for (var at = 0; at < text.length || at === 0; at += CHUNK) {
      bridge("output", JSONstringify({ type: "text", text: StringSlice(text, at, at + CHUNK) }));
      if (text.length === 0) break;
    }
  }
  function consoleWrite(args) {
    if (consoleCut) return;
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === "string") parts[parts.length] = a;
      else {
        var j;
        try { j = JSONstringify(a); } catch (e) { j = undefined; }
        parts[parts.length] = j === undefined ? StringCtor(a) : j;
      }
    }
    var line = ArrayJoin(parts, " ") + "\n";
    if (consoleBytes + line.length > CONSOLE_QUOTA) {
      consoleCut = true;
      emitText("[console output truncated]\n");
      return;
    }
    consoleBytes += line.length;
    emitText(line);
  }

  function define(name, value) {
    ObjectDefineProperty(G, name, { value: value, writable: false, configurable: false, enumerable: false });
  }

  var tools = ObjectFreeze({ call: toolCall });
  var catalog = ObjectFreeze({
    search: function (query, options) {
      var limit = options && NumberIsInteger(options.limit) ? options.limit : 10;
      return catalogRequest("search", StringCtor(query === undefined ? "" : query), limit);
    },
    describe: function (name) {
      return PromiseThen(catalogRequest("describe", StringCtor(name), 1), function (entries) {
        if (entries.length === 0) throw fail("TOOL_UNAVAILABLE", 'Tool "' + StringCtor(name) + '" is not available');
        return entries[0];
      });
    }
  });
  var stateApi = ObjectFreeze({
    get: function (key) { return state[key]; },
    set: function (key, value) {
      if (typeof key !== "string" || key === "" || key.length > 128)
        throw fail("INVALID_INPUT", "state key must be 1 to 128 characters");
      var json = JSONstringify(value);
      if (json === undefined) throw fail("INVALID_INPUT", "state value must be JSON");
      if (json.length > 65536) throw fail("INVALID_INPUT", "state value is larger than 65536 bytes");
      state[key] = JSONparse(json);
      bridge("state.set", JSONstringify({ key: key, value: json }));
    },
    delete: function (key) {
      if (typeof key !== "string" || key === "" || key.length > 128)
        throw fail("INVALID_INPUT", "state key must be 1 to 128 characters");
      delete state[key];
      bridge("state.delete", JSONstringify({ key: key }));
    }
  });
  var parallel = ObjectFreeze({
    map: function (items, fn, options) { return pool(items, fn, options, false); },
    settle: function (items, fn, options) { return pool(items, fn, options, true); }
  });
  var consoleApi = ObjectFreeze({
    log: function () { consoleWrite(arguments); },
    warn: function () { consoleWrite(arguments); },
    error: function () { consoleWrite(arguments); }
  });
  function progress(event) {
    if (!event || typeof event.message !== "string") throw new TypeErrorCtor("progress needs a message");
    bridge("progress", JSONstringify({ message: StringSlice(event.message, 0, 500), completed: event.completed, total: event.total }));
  }

  function init(rawLimits, snapshot) {
    limits = JSONparse(rawLimits);
    var values = JSONparse(snapshot);
    var keys = ObjectKeys(values);
    for (var i = 0; i < keys.length; i++) state[keys[i]] = values[keys[i]];
    define("tools", tools);
    define("catalog", catalog);
    define("state", stateApi);
    define("text", emitText);
    define("progress", progress);
    define("parallel", parallel);
    define("console", consoleApi);
    define("callTool", toolCall);
    delete G.SharedArrayBuffer;
    delete G.InternalError;
  }

  async function run(fn) {
    try {
      var value = await fn();
      if (value === undefined) return '{"ok":true}';
      var json = JSONstringify(value);
      if (json === undefined) return '{"ok":true}';
      if (json.length > MAX_RETURN)
        throw fail("OUTPUT_LIMIT", "the returned value is larger than " + MAX_RETURN + " characters; return less (filter, aggregate or paginate)");
      return '{"ok":true,"value":' + json + "}";
    } catch (e) {
      var info = { ok: false, code: "SCRIPT_RUNTIME", name: "Error", message: "" };
      try {
        if (e !== null && typeof e === "object") {
          if (typeof e.code === "string" && PASS_CODES[e.code] === true) info.code = e.code;
          if (typeof e.name === "string") info.name = e.name;
          info.message = StringCtor(e.message);
          // A limit counts only when the ENGINE raised it (its own error type), never by message text.
          // Memory: QuickJS raises an InternalError a script cannot construct. Stack: QuickJS raises a
          // RangeError, which a script can imitate; the worst that buys is that label on a failed run.
          var proto = ObjectGetPrototypeOf(e);
          if (InternalErrorProto !== undefined && proto === InternalErrorProto &&
              StringIndexOf(info.message, "out of memory") >= 0) info.limit = "MEMORY_LIMIT";
          else if (proto === RangeErrorProto && StringIndexOf(info.message, "call stack size") >= 0)
            info.limit = "STACK_LIMIT";
        } else info.message = StringCtor(e);
      } catch (inner) { info.message = "unprintable error"; }
      return JSONstringify(info);
    }
  }

  function waiting() { return waiters.length; }

  return { init: init, run: run, grant: grant, waiting: waiting };
})`;

export const PRELUDE_HASH = sha256Hex(`${PRELUDE_VERSION}:${PRELUDE_SOURCE}`);
