/** Keep Node-only startup code out of Next's Edge instrumentation bundle. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const node = await import('@/lib/server/instrumentation-node');
    await node.register();
  }
}
