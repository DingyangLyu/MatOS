# DeepSeek Harness runtime

MatOS runs its agents on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT). `VERSION.json` pins the release and commit, and `scripts/matos-setup.sh` prepares that runtime with Node 24.

- `matos-plugin/` registers MatOS asset discovery, asset reads and project policy as DSH tools.
- `matos-sdk-profile/` adds MatOS policy and persistent-turn extensions to the DSH SDK profile.
