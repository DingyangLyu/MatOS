#!/usr/bin/env python3
"""Regression checks for public WSWQ label normalization; no model calls."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np


spec = importlib.util.spec_from_file_location(
    "mattools_bench", Path(__file__).with_name("matos-mattools-agentic-bench.py")
)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class WswqContractTests(unittest.TestCase):
    def setUp(self):
        # Derive both slopes from the public question's data and formula.
        overlaps = np.stack([np.ones((3, 5)), np.zeros((3, 5)), np.ones((3, 5))])
        def slope(grid):
            signed = overlaps * np.sign(grid)[:, None, None]
            return np.polyfit(grid, signed.reshape(3, -1), 1)[0].reshape(3, 5)
        self.increasing = slope(np.array([-0.5, 0, 0.5]))
        self.decreasing = slope(np.array([1.0, 0, -1.0]))
        self.pos = "wswq_slope_positive_distortion"
        self.neg = "wswq_slope_negative_distortion"

    def adapt(self, result):
        namespace = {"solve": lambda: result}
        exec(bench.contract_adapter_source("test_wswq_slope", "solve", "solve"), namespace)
        adapted = namespace["solve"]()
        self.last_events = namespace.get("_mattools_contract_events", [])
        return adapted

    def test_correct_labels_are_preserved(self):
        values = {self.pos: self.increasing, self.neg: self.decreasing}
        result = self.adapt(values)
        self.assertIs(result[self.pos], self.increasing)
        self.assertIs(result[self.neg], self.decreasing)
        self.assertEqual(self.last_events[-1]["action"], "preserve")

    def test_alternate_labels_are_canonicalized_without_changing_values(self):
        values = {self.pos: self.decreasing, self.neg: self.increasing}
        result = self.adapt(values)
        self.assertIs(result[self.pos], self.increasing)
        self.assertIs(result[self.neg], self.decreasing)
        self.assertIs(values[self.pos], self.decreasing)
        self.assertIs(values[self.neg], self.increasing)
        self.assertEqual(self.last_events[-1]["action"], "swap")
        self.assertFalse(self.last_events[-1]["numericValuesChanged"])

    def test_normalization_is_idempotent(self):
        once = self.adapt({self.pos: self.decreasing, self.neg: self.increasing})
        twice = self.adapt(once)
        for key in (self.pos, self.neg):
            np.testing.assert_array_equal(once[key], twice[key])

    def test_unrelated_numeric_errors_are_not_repaired(self):
        values = {self.pos: np.full((3, 5), 7.0), self.neg: np.full((3, 5), 3.0)}
        original = values.copy()
        result = self.adapt(values)
        for key in values:
            self.assertIs(result[key], original[key])

    def test_scaled_wrong_values_remain_wrong(self):
        # The adapter may relabel a matching pair but must never fix its scale.
        low, high = self.decreasing * 1.5, self.increasing * 1.5
        result = self.adapt({self.pos: low, self.neg: high})
        self.assertIs(result[self.pos], high)
        self.assertIs(result[self.neg], low)
        self.assertFalse(np.allclose(result[self.pos], self.increasing))

    def test_missing_nonfinite_negative_and_mismatched_values_are_unchanged(self):
        for positive, negative in [
            (None, self.increasing),
            (np.full((3, 5), np.nan), self.increasing),
            (-self.decreasing, -self.increasing),
            (np.ones((3, 1)), self.increasing),
            (np.array([]), np.array([])),
            (np.zeros((3, 5)), np.zeros((3, 5))),
            ("invalid", self.increasing),
        ]:
            with self.subTest(positive=repr(positive)):
                result = self.adapt({self.pos: positive, self.neg: negative})
                self.assertIs(result[self.pos], positive)
                self.assertIs(result[self.neg], negative)


if __name__ == "__main__":
    unittest.main()
