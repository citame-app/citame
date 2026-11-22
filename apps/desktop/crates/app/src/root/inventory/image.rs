use super::*;
use sob_core::staff_portrait_image::prepare_photo;

type Image = Arc<gpui::RenderImage>;
type PreparedImage = Option<(Vec<u8>, Image)>;
pub(super) type Preview = Entity<Image>;

pub(super) fn tracked_image(image: Image, cx: &mut Context<Root>) -> Preview {
    cx.new(|cx| {
        cx.on_release(|image: &mut Image, app| app.drop_image(image.clone(), None))
            .detach();
        image
    })
}

pub(super) fn pick_inventory_image(
    cx: &mut Context<Root>,
    prompt: SharedString,
) -> impl Future<Output = Result<PreparedImage, Key>> + use<> {
    let renderer = cx.svg_renderer();
    let executor = cx.background_executor().clone();
    let picker = cx.prompt_for_paths(gpui::PathPromptOptions {
        files: true,
        directories: false,
        multiple: false,
        prompt: Some(prompt),
    });
    async move {
        let paths = picker
            .await
            .map_err(|_| Key::StaffPortraitInvalid)?
            .map_err(|_| Key::StaffPortraitInvalid)?;
        let Some(path) = paths.and_then(|paths| paths.into_iter().next()) else {
            return Ok(None);
        };
        executor
            .spawn(async move {
                let bytes = prepare_photo(&path).ok_or(Key::StaffPortraitInvalid)?;
                let image = gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes.clone())
                    .to_image_data(renderer)
                    .map_err(|_| Key::StaffPortraitInvalid)?;
                Ok(Some((bytes, image)))
            })
            .await
    }
}
