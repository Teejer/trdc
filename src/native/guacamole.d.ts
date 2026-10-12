/**
 * guacamole-common-js ships as a single untyped UMD/ESM bundle. A full
 * hand-written type surface is unnecessary here: the code paths use it in a
 * few well-known shapes, so we declare the default export loosely and rely on
 * the runtime library. Members are typed as `any` at the call sites that need
 * structure.
 */
declare module 'guacamole-common-js' {
  const Guacamole: any;
  export default Guacamole;
}
