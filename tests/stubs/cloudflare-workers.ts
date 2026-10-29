/** Just enough of Cloudflare's runtime to run relay/worker.js in tests. */
export class DurableObject {
  ctx: any;
  env: any;
  constructor(ctx: any, env: any) {
    this.ctx = ctx;
    this.env = env;
  }
}
