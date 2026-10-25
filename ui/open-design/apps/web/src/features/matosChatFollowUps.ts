// MatOS product gate for the in-project follow-up placeholder rotation.
//
// When true (the MatOS product default), ChatPane's empty composer rotates
// materials-science follow-up prompts (summarize results, check convergence,
// save the procedure as an asset, …) once a conversation has messages,
// instead of the upstream Open Design design-toolbox prompts (visual polish,
// motion polish, icon workflow, …) which read as irrelevant in a MatOS
// compute session. Hidden, not deleted: flipping this back to `false`
// restores the upstream rotation without a code revert (same pattern as
// MATOS_HOME_TEMPLATES_VISIBLE).
export const MATOS_CHAT_FOLLOW_UPS_VISIBLE = true;
