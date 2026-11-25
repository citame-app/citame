use image::{ImageDecoder, ImageFormat, ImageReader, Limits, codecs::jpeg::JpegEncoder};
use std::io::{Cursor, Read};
use std::path::Path;

pub(crate) const INPUT_LIMIT: usize = 512 * 1024;

pub(crate) fn is_bounded_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(&[255, 216, 255])
        && ImageReader::with_format(Cursor::new(bytes), ImageFormat::Jpeg)
            .into_dimensions()
            .is_ok_and(|(width, height)| {
                (1..=1024).contains(&width) && (1..=1024).contains(&height)
            })
}

pub fn prepare_photo(path: &Path) -> Option<Vec<u8>> {
    prepare_photo_with_limit(path, 20 * 1024 * 1024)
}

pub fn prepare_photo_with_limit(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > max_bytes {
        return None;
    }

    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    if !matches!(
        reader.format()?,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP
    ) {
        return None;
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(160 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > 32_000_000 {
        return None;
    }
    let orientation = decoder.orientation().ok()?;
    let mut image = image::DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    let thumbnail = image.thumbnail(1024, 1024).into_rgba8();
    let printable = image::RgbImage::from_fn(thumbnail.width(), thumbnail.height(), |x, y| {
        let [r, g, b, alpha] = thumbnail.get_pixel(x, y).0;
        let opaque = |value| {
            let alpha = u32::from(alpha);
            ((u32::from(value) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        };
        image::Rgb([opaque(r), opaque(g), opaque(b)])
    });
    for quality in [78, 62, 48] {
        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, quality)
            .encode_image(&printable)
            .ok()?;
        if output.len() <= INPUT_LIMIT {
            return Some(output);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portrait_upload_resizes_raster_and_rejects_unsupported_content() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("portrait.png");
        image::RgbaImage::from_pixel(1600, 700, image::Rgba([12, 60, 80, 0]))
            .save(&source)
            .unwrap();
        let jpeg = prepare_photo(&source).unwrap();
        let image = image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg)
            .unwrap()
            .into_rgb8();
        assert_eq!(image.width(), 1024);
        assert!(image.get_pixel(0, 0).0.iter().all(|value| *value >= 250));
        std::fs::write(&source, b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        assert!(prepare_photo(&source).is_none());
    }
}
