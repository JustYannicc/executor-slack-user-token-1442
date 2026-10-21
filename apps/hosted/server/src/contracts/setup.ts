import { Schema } from "effect";

/**
 * The order of a new team's setup steps before its first prompt. Cloud's onboarding experiment
 * assigns one to each team created through team setup; every other team, and every other host,
 * connects accounts first.
 */
export const SetupOrder = Schema.Literals(["accounts_first", "assistant_first"]);
export type SetupOrder = typeof SetupOrder.Type;
