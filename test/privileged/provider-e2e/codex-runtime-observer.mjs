import {
  cleanupProviderRuntimeObserver,
  runProviderRuntimeObserver
} from "./provider-runtime-observer.mjs";

export function run(testContext, context) {
  return runProviderRuntimeObserver("codex", testContext, context);
}

export function cleanup(context) {
  return cleanupProviderRuntimeObserver(context);
}
