export function contrastTextColor(hexColor: string) {
  if (!/^#[0-9a-f]{6}$/i.test(hexColor)) return "#171815";
  const channels = [1, 3, 5].map(offset => Number.parseInt(hexColor.slice(offset, offset + 2), 16) / 255);
  const luminance = channels
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  return luminance > 0.179 ? "#171815" : "#fffefa";
}
