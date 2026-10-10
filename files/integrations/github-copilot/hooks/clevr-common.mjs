// Re-export, so the gate can import a SIBLING (which is what it will be once
// installed into ~/.clevr/tools) while the logic lives in exactly one place.
// The installer copies the real file over this one at the destination.
export * from '../../claude-code/hooks/clevr-common.mjs';
