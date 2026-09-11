/* TEST FIXTURE - key 已过期，应判 INVALID
   本文件不含任何真实凭据：token 为构造值，签名是固定假串。 */
window.SUPA = {
  url: "https://abcdefghijklmnopqrst.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbG1ub3BxcnN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTI2MjMwNDAwMH0.fake-signature-for-tests-only"
};
