fn main() {
    let img = image::open("../app-icon.png").unwrap();
    img.save("../app-icon-real.png").unwrap();
}
