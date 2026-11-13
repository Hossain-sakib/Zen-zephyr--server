const { copyImage } = require('./scripts/image-migration');
function cloudImage(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const cloud = new URL(process.env.CLOUDINARY_URL);
    const image = new URL(value);
    return image.protocol === 'https:' && !image.username && !image.password && image.hostname === 'res.cloudinary.com' && image.pathname.startsWith(`/${cloud.hostname}/image/upload/`) ? value : '';
  } catch { return ''; }
}
async function profileImage(value) {
  if (cloudImage(value)) return value;
  try {
    const url = new URL(value);
    // Only import Google's verified-provider avatar host, not arbitrary client URLs.
    if (url.protocol === 'https:' && (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'))) return (await copyImage(value)).url;
  } catch { /* Avatar initials remain available if a provider image is unavailable. */ }
  return '';
}
module.exports = { cloudImage, profileImage };
