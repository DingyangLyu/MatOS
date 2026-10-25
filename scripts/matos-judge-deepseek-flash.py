#!/usr/bin/env python3
"""Run a benchmark scorer with DeepSeek Flash as a non-thinking judge.

This is the judge configuration used for the 2026-10-13 DSH + Flash scores:
every judge call must use deepseek-flash, thinking is disabled, and the key
comes from DEEPSEEK_API_KEY. Usage:

    DEEPSEEK_API_KEY=... python3 scripts/matos-judge-deepseek-flash.py \
        scripts/sciagentgym-official-eval.py --judge-model deepseek-flash ...
"""
import os
import runpy
import sys

from openai.resources.chat.completions import Completions

BASE_URL = 'https://api.deepseek.com/v1'
MODEL = 'deepseek-flash'

original = Completions.create


def create(self, *args, **kwargs):
    if kwargs.get('model') != MODEL:
        raise RuntimeError(f'Judge attempted a model other than {MODEL}')
    extra = dict(kwargs.get('extra_body') or {})
    extra['thinking'] = {'type': 'disabled'}
    kwargs['extra_body'] = extra
    return original(self, *args, **kwargs)


Completions.create = create
key = os.environ.get('DEEPSEEK_API_KEY')
if not key:
    raise SystemExit('Set DEEPSEEK_API_KEY for the judge.')
os.environ.update(
    JUDGE_API_KEY=key, JUDGE_API_BASE=BASE_URL, JUDGE_MODEL_NAME=MODEL,
    SCIAGENTGYM_JUDGE_API_KEY=key, SCIAGENTGYM_JUDGE_BASE_URL=BASE_URL, SCIAGENTGYM_JUDGE_MODEL=MODEL,
)
if len(sys.argv) < 2:
    raise SystemExit('Usage: matos-judge-deepseek-flash.py <scorer.py> [scorer args...]')
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
