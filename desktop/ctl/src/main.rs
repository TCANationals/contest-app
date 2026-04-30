use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: tca-timer-ctl <help|timer> <request|cancel|show|hide>");
        std::process::exit(2);
    }

    let path = match (args[1].as_str(), args[2].as_str()) {
        ("help", "request") => "/help/request",
        ("help", "cancel") => "/help/cancel",
        ("timer", "show") => "/timer/show",
        ("timer", "hide") => "/timer/hide",
        _ => {
            eprintln!("Unsupported command");
            std::process::exit(2);
        }
    };

    // TODO(spec §9.6.3): call local API and show Windows toast notifications.
    println!("Placeholder: would POST to http://127.0.0.1:17380{}", path);
}
