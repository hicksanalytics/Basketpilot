import { createReceiptConsentHandler } from './community-price-transport.mjs';

const invalidSessionCodes = new Set(['bad_jwt', 'session_expired', 'session_not_found', 'user_not_found']);

// Supply a stateless Supabase Auth client and a dedicated database connection
// whose login can assume receipt_community_consent. transaction() must use one
// connection for the entire callback and commit or roll back before releasing it.
export function createSupabaseReceiptConsentHandler({ auth, database }) {
  return createReceiptConsentHandler({
    async authenticate(accessToken) {
      const { data, error } = await auth.getUser(accessToken);
      if (error) {
        if (error.status === 401 || error.name === 'AuthSessionMissingError' || invalidSessionCodes.has(error.code)) {
          return null;
        }
        throw error;
      }
      return data?.user?.is_anonymous === true ? null : data?.user;
    },

    async setConsent({ receiptId, action, revision, previewToken }, { ownerId }) {
      return database.transaction(async tx => {
        await tx.query('set local role receipt_community_consent');
        // Set both forms for older auth.uid() definitions. The only claim
        // supplied to SQL comes from the server-verified user record.
        await tx.query(
          "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
          [ownerId, JSON.stringify({ sub: ownerId })]
        );
        const { rows } = await tx.query(
          'select * from receipt_community.set_consent($1,$2,$3,$4)',
          [receiptId, action, revision, previewToken]
        );
        return rows[0];
      });
    }
  });
}
