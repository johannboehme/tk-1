//! Bare-bones timing harness — calls sync_audio_pcm exactly once on
//! two raw f32-LE PCM files and reports wall-clock for production
//! comparison.

use std::env;
use std::fs;
use std::io::Read;
use std::time::Instant;

use sync_core::sync::{sync_audio_pcm, SyncOptions};

const SR: u32 = 22050;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: {} <ref.f32> <query.f32>", args[0]);
        std::process::exit(1);
    }
    let ref_pcm = read_f32le(&args[1]).unwrap();
    let query_pcm = read_f32le(&args[2]).unwrap();
    let dur = ref_pcm.len() as f64 / SR as f64;
    println!(
        "ref={} samples ({:.1} s), query={} samples ({:.1} s)",
        ref_pcm.len(),
        dur,
        query_pcm.len(),
        query_pcm.len() as f64 / SR as f64,
    );

    let start = Instant::now();
    let result = sync_audio_pcm(&ref_pcm, &query_pcm, SyncOptions::default());
    let elapsed = start.elapsed();

    println!("method        : {}", result.method);
    println!("offset_ms     : {:+.3}", result.offset_ms);
    println!("confidence    : {:.4}", result.confidence);
    println!("phat_pnr      : {:.2}", result.phat_pnr);
    println!("elapsed       : {:.3} s", elapsed.as_secs_f64());
    println!(
        "throughput    : {:.1}× realtime",
        dur / elapsed.as_secs_f64()
    );
}

fn read_f32le(path: &str) -> std::io::Result<Vec<f32>> {
    let mut f = fs::File::open(path)?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    let mut samples = Vec::with_capacity(bytes.len() / 4);
    for c in bytes.chunks_exact(4) {
        samples.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
    }
    Ok(samples)
}
