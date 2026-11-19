import { enginePlugin } from './engine.js';
import { githubPlugin } from './github.js';
import { trustedIssuerPlugin } from './trusted-issuer.js';
import type { AuthPluginDefinition } from './types.js';

/**
 * Every auth adapter this build knows, by the id `AUTH_PROVIDERS` lists.
 * Adding an adapter is one new file next to this one and one line here.
 */
export const AUTH_PLUGINS: Readonly<Record<string, AuthPluginDefinition<any>>> = {
  [githubPlugin.id]: githubPlugin,
  [trustedIssuerPlugin.id]: trustedIssuerPlugin,
  [enginePlugin.id]: enginePlugin
};

/** `AUTH_PROVIDERS` when unset: GitHub sign-in, as before plugins existed. */
export const DEFAULT_AUTH_PROVIDERS = ['github'];
