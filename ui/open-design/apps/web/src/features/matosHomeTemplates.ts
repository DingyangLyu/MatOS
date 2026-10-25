// MatOS product gate for the Home "start from a template" rail.
//
// When true (the MatOS product default), the Home hero renders the MatOS
// template catalog — asset draft templates plus project kick-off starters —
// instead of the upstream Open Design create rail (deck / prototype / …).
// Upstream rail tests mock this to false so the original scenario-rail
// behavior stays covered; MatOS-mode coverage lives in
// tests/components/HomeHero.matos-templates.test.tsx.
export const MATOS_HOME_TEMPLATES_VISIBLE = true;
