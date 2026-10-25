import { describe, expect, test } from "bun:test";
import {
  attributeMatOSAlgorithmReward,
  matOSAlgorithmAttributionVersion,
} from "./attribution.js";

describe("algorithm reward attribution", () => {
  test("assigns terminal credit to the final decision by default", () => {
    const result = attributeMatOSAlgorithmReward({
      decisionIds: ["decision-a", "decision-b", "decision-c"],
      rewardValue: -0.75,
      objectiveRef: "evaluation:terminal-success@1",
      method: "terminal",
      confidence: 0.9,
    });

    expect(result.reward).toEqual({
      value: -0.75,
      objectiveRef: "evaluation:terminal-success@1",
      attributionMethod: "terminal",
      attributionVersion: matOSAlgorithmAttributionVersion("terminal"),
      confidence: 0.9,
    });
    expect(result.decisionAttributions).toEqual([
      {
        decisionId: "decision-a",
        credit: 0,
        attributedValue: 0,
      },
      {
        decisionId: "decision-b",
        credit: 0,
        attributedValue: 0,
      },
      {
        decisionId: "decision-c",
        credit: 1,
        attributedValue: -0.75,
      },
    ]);
  });

  test("assigns deterministic uniform credit without losing total reward", () => {
    const result = attributeMatOSAlgorithmReward({
      decisionIds: ["decision-a", "decision-b", "decision-c"],
      rewardValue: 1,
      objectiveRef: "evaluation:quality@2",
      method: "uniform",
    });

    expect(result.reward.attributionVersion).toBe(
      matOSAlgorithmAttributionVersion("uniform"),
    );
    expect(result.decisionAttributions).toHaveLength(3);
    expect(
      result.decisionAttributions.reduce(
        (total, item) => total + item.attributedValue,
        0,
      ),
    ).toBe(1);
    expect(
      result.decisionAttributions.reduce(
        (total, item) => total + item.credit,
        0,
      ),
    ).toBe(1);
  });

  test("rejects duplicate decisions and invalid confidence", () => {
    expect(() =>
      attributeMatOSAlgorithmReward({
        decisionIds: ["same", "same"],
        rewardValue: 1,
        objectiveRef: "evaluation:test@1",
        method: "uniform",
      }),
    ).toThrow("decisionIds must be unique");
    expect(() =>
      attributeMatOSAlgorithmReward({
        decisionIds: ["decision"],
        rewardValue: 1,
        objectiveRef: "evaluation:test@1",
        method: "terminal",
        confidence: 1.1,
      }),
    ).toThrow("confidence");
  });
});
