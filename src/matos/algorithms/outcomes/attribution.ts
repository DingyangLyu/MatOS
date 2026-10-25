import type {
  MatOSAlgorithmAttributionMethod,
  MatOSAlgorithmDecisionAttribution,
  MatOSAlgorithmReward,
} from "./types.js";

export type MatOSAlgorithmBuiltinAttributionMethod = "terminal" | "uniform";

const ATTRIBUTION_VERSIONS: Record<
  MatOSAlgorithmBuiltinAttributionMethod,
  string
> = {
  terminal: "terminal@1",
  uniform: "uniform@1",
};

export function matOSAlgorithmAttributionVersion(
  method: MatOSAlgorithmBuiltinAttributionMethod,
): string {
  return ATTRIBUTION_VERSIONS[method];
}

function requiredReference(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 2048 ||
    normalized !== value ||
    /[\0\r\n]/u.test(normalized)
  ) {
    throw new Error(`${label} must be a bounded single-line reference`);
  }
  return normalized;
}

export function attributeMatOSAlgorithmReward(input: {
  decisionIds: readonly string[];
  rewardValue: number;
  objectiveRef: string;
  method: MatOSAlgorithmBuiltinAttributionMethod;
  terminalDecisionId?: string;
  confidence?: number;
}): {
  reward: MatOSAlgorithmReward;
  decisionAttributions: MatOSAlgorithmDecisionAttribution[];
} {
  if (!Number.isFinite(input.rewardValue)) {
    throw new Error("rewardValue must be finite");
  }
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1)
  ) {
    throw new Error("confidence must be between 0 and 1");
  }
  const objectiveRef = requiredReference(input.objectiveRef, "objectiveRef");
  const decisionIds = input.decisionIds.map((decisionId, index) =>
    requiredReference(decisionId, `decisionIds[${index}]`),
  );
  if (new Set(decisionIds).size !== decisionIds.length) {
    throw new Error("decisionIds must be unique");
  }
  const attributionVersion = matOSAlgorithmAttributionVersion(input.method);
  const reward: MatOSAlgorithmReward = {
    value: input.rewardValue,
    objectiveRef,
    attributionMethod: input.method,
    attributionVersion,
    ...(input.confidence === undefined
      ? {}
      : { confidence: input.confidence }),
  };
  if (decisionIds.length === 0) {
    return { reward, decisionAttributions: [] };
  }

  if (input.method === "terminal") {
    const terminalDecisionId = input.terminalDecisionId
      ? requiredReference(input.terminalDecisionId, "terminalDecisionId")
      : decisionIds.at(-1)!;
    if (!decisionIds.includes(terminalDecisionId)) {
      throw new Error("terminalDecisionId must be present in decisionIds");
    }
    return {
      reward,
      decisionAttributions: decisionIds.map((decisionId) => ({
        decisionId,
        credit: decisionId === terminalDecisionId ? 1 : 0,
        attributedValue:
          decisionId === terminalDecisionId ? input.rewardValue : 0,
      })),
    };
  }

  const credit = 1 / decisionIds.length;
  let attributed = 0;
  const decisionAttributions = decisionIds.map((decisionId, index) => {
    const attributedValue =
      index === decisionIds.length - 1
        ? input.rewardValue - attributed
        : input.rewardValue * credit;
    attributed += attributedValue;
    return { decisionId, credit, attributedValue };
  });
  // Floating-point division can leave the credit sum one ulp away from one.
  const priorCredit = credit * (decisionIds.length - 1);
  decisionAttributions[decisionAttributions.length - 1]!.credit =
    1 - priorCredit;
  return { reward, decisionAttributions };
}

export function isBuiltinMatOSAlgorithmAttributionMethod(
  value: MatOSAlgorithmAttributionMethod,
): value is MatOSAlgorithmBuiltinAttributionMethod {
  return value === "terminal" || value === "uniform";
}
