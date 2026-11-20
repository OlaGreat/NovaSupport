import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { containsProfanity, generateSuggestions, validateUsername } from "./username-validator.js";

test("generated username suggestions stay within the 32-character limit", () => {
  const suggestions = generateSuggestions("a".repeat(32));
  assert.ok(suggestions.length > 0);
  assert.ok(
    suggestions.every((suggestion) => suggestion.length <= 32),
    suggestions.join(", "),
  );
  assert.match(suggestions[0], /^a+-\d{1,4}$/);
});

test("first username suggestion is length guarded even with the largest numeric suffix", () => {
  const random = mock.method(Math, "random", () => 0.9999);

  try {
    const [firstSuggestion] = generateSuggestions("b".repeat(32));
    assert.equal(firstSuggestion.length, 32);
    assert.equal(firstSuggestion.endsWith("-9999"), true);
  } finally {
    random.mock.restore();
  }
});

test("profanity filter catches the bare word and its common forms (#1522)", () => {
  for (const username of ["fuck", "fucks", "fucked", "fucker", "fuckers", "fuckin", "fucking"]) {
    assert.equal(containsProfanity(username), true, username);
  }
});

test("profanity filter catches the bare word in hyphenated usernames", () => {
  for (const username of ["fuck-off", "big-fuck", "the-fucking-best"]) {
    assert.equal(containsProfanity(username), true, username);
    const result = validateUsername(username);
    assert.equal(result.valid, false, username);
    assert.equal(result.error, "Username contains inappropriate content");
  }
});

test("profanity filter still catches the compound forms it already listed", () => {
  assert.equal(containsProfanity("motherfucker"), true);
});

test("profanity filter does not flag clean usernames", () => {
  for (const username of ["alice", "nova-support", "fuchsia", "luck-duck"]) {
    assert.equal(containsProfanity(username), false, username);
  }
});
