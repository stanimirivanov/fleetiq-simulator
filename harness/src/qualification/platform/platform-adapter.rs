//! Bounded line adapter for the pinned native platform decoder, not a second parser.
use std::fmt::Write as _;
use std::io::{self, Read, Write};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().take(2_000_001).read_to_string(&mut input)?;
    if input.len() > 2_000_000 || !input.ends_with('\n') || input.lines().count() > 512 {
        return Err("adapter-input-bound".into());
    }
    let mut output = io::BufWriter::new(io::stdout());
    for line in input.lines() {
        if line.is_empty() || line.len() > 2560 || line.len() % 2 != 0 {
            return Err("adapter-line-bound".into());
        }
        let frame = line
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| Ok(u8::from_str_radix(std::str::from_utf8(pair)?, 16)?))
            .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
        match fleetiq_teltonika::decode(&frame) {
            Err(error) => writeln!(output, "reject:{}", error as u32)?,
            Ok(packet) => {
                if packet.records.is_empty() || packet.records.len() > 16 {
                    return Err("adapter-record-count".into());
                }
                for record in &packet.records {
                    let mut io = String::new();
                    for (index, value) in record.io.iter().enumerate() {
                        if index != 0 {
                            io.push(',');
                        }
                        write!(io, "{}:", value.id)?;
                        for byte in &value.bytes {
                            write!(io, "{byte:02x}")?;
                        }
                    }
                    writeln!(
                        output,
                        "ok\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                        packet.codec,
                        packet.records.len(),
                        record.timestamp_ms,
                        record.priority,
                        record.gps.longitude,
                        record.gps.latitude,
                        record.gps.altitude_raw,
                        record.gps.angle,
                        record.gps.satellites,
                        record.gps.speed,
                        record.event_io_id,
                        io
                    )?;
                }
            }
        }
    }
    output.flush()?;
    Ok(())
}

fn main() {
    if run().is_err() {
        eprintln!("platform-adapter-failed; check bounded input and decoder contract privately.");
        std::process::exit(2);
    }
}
