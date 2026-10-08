// Sign-up now verifies the email address first (request code -> verify code -> create account). Tests run against a server
// that returns the code in the response (log email provider + NODE_ENV=test), so this does the whole dance in one call.
// `post(path, body)` is the test file's own POST helper and must return { status, json }.
export async function verifyEmail(post, email) {
  const r1 = await post('/api/auth/signup/request-code', { email });
  if (r1.status !== 200) return { fail: r1 };
  const r2 = await post('/api/auth/signup/verify-code', { email, code: r1.json.demoOtp });
  if (r2.status !== 200 || !r2.json.signupToken) return { fail: r2, existing: r2.json };
  return { signupToken: r2.json.signupToken };
}

// Returns whatever POST /api/auth/signup returns. If the email step itself fails, that failure is returned instead.
export async function signupV(post, body) {
  const v = await verifyEmail(post, body.email);
  if (v.fail) return v.fail;
  const { email, ...rest } = body;
  const r = await post('/api/auth/signup', { ...rest, signupToken: v.signupToken });
  // Older tests then sign in with the emailed code: ask for one the ordinary way and expose it as demoOtp, as sign-up used to.
  if (r.status === 200 && r.json?.handoff) {
    const o = await post('/api/auth/admin/request-otp', { email });
    if (o.json?.demoOtp) r.json.demoOtp = o.json.demoOtp;
  }
  return r;
}
