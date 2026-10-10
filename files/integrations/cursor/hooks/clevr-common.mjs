// Re-export, so each hook imports a SIBLING (which is what it will be once
// installed into ~/.cursor/clevr-hooks). The installer copies the real file over
// this one at the destination.
//
// This used to be a full second copy of the shared helpers. It drifted: the copy
// was the only place `mode` was read, and it was about to become the only place
// the three body builders were missing. Four integrations already do it this way.
export * from '../../claude-code/hooks/clevr-common.mjs';
