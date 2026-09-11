/* TEST FIXTURE - 段数对但 payload 解不开，应判 INVALID
   本文件不含任何真实凭据：token 为构造值，签名是固定假串。 */
window.SUPA = {
  url: "https://abcdefghijklmnopqrst.supabase.co",
  anonKey: "abc.!!!not-base64!!!.sig"
};
