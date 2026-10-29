// Web Push isn't used on the phone; notifications go through Android (see mobile/engine.ts).
const webpush = {
  setVapidDetails() {},
  async sendNotification() { throw new Error('Web Push is not available in the mobile app'); },
  generateVAPIDKeys() { return { publicKey: '', privateKey: '' }; },
};
export default webpush;
