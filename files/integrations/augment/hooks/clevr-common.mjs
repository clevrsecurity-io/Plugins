// Re-export, so the gate imports a SIBLING (which is what it will be once
// installed into ~/.clevr/tools). The installer copies the real file over this
// one at the destination, so the logic lives in exactly one place.
export * from '../../claude-code/hooks/clevr-common.mjs';
