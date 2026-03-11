import { describe, test, expect, beforeAll } from "bun:test";
import { getSystemPrompt } from "../src/config.js";

describe("getSystemPrompt", () => {
  test("includes agent name", () => {
    const prompt = getSystemPrompt("TestBot");
    expect(prompt).toContain("Your name is TestBot");
  });

  test("includes respond tool instructions", () => {
    const prompt = getSystemPrompt("TestBot");
    expect(prompt).toContain("respond");
    expect(prompt).toContain("msg");
    expect(prompt).toContain("shortcut");
  });

  test("includes workspace section", () => {
    const prompt = getSystemPrompt("TestBot");
    expect(prompt).toContain("workspace/");
  });

  test("includes background jobs section", () => {
    const prompt = getSystemPrompt("TestBot");
    expect(prompt).toContain("background job");
    expect(prompt).toContain("cron");
  });
});
