#!/usr/bin/env node

import { Transform, TransformCallback } from 'stream'

import { TSPacket, TSPacketQueue } from 'arib-mpeg2ts-parser';
import { TSSection, TSSectionQueue, TSSectionPacketizer } from 'arib-mpeg2ts-parser';
import { TSPES, TSPESQueue, TSPESPacketizer } from 'arib-mpeg2ts-parser';

const PCR_WRAP = 2 ** 33;
const isAfter = (PTS: number, PCR: number) => ((PTS - PCR + PCR_WRAP) % PCR_WRAP) <= (PCR_WRAP / 2);

export default class TSSubtitleTransform extends Transform {
  private PCR_offset: number;

  private input_PacketQueue: TSPacketQueue = new TSPacketQueue();
  private meta_PacketQueue: TSPacketQueue;

  private input_PAT_TSSectionQueue: TSSectionQueue = new TSSectionQueue();
  private input_PMT_TSSectionQueue: TSSectionQueue = new TSSectionQueue();
  private input_PMT_PID: number | null = null;
  private input_PMT_PCR_PID: number | null = null;
  private input_PMT_CC: number = 0;
  private input_first_PCR: number | null = null;

  private meta_PAT_TSSectionQueue: TSSectionQueue = new TSSectionQueue();
  private meta_PMT_TSSectionQueue: TSSectionQueue = new TSSectionQueue();
  private meta_PMT_PESQueues: Map<number, TSPESQueue> = new Map<number, TSPESQueue>();
  private meta_PMT: Buffer | null = null;
  private meta_PMT_PID: number | null = null;
  private meta_PMT_PCR_PID: number | null = null;
  private meta_first_PCR: number | null = null;
  private meta_elapsed_PCR: number = 0;
  private meta_to_input_Generic_Section_PID_mapping: Map<number, number> = new Map<number, number>();
  private meta_to_input_PMT_Section_PID_mapping: Map<number, number> = new Map<number, number>();
  private meta_to_input_PMT_PES_PID_mapping: Map<number, number> = new Map<number, number>();
  private meta_to_input_PMT_PES_CC: Map<number, number> = new Map<number, number>();

  constructor (meta_PacketQueue: TSPacketQueue, section_pids: number[], target_offset?: number) {
    super();
    this.meta_PacketQueue = meta_PacketQueue;
    section_pids.forEach((pid) => {
      this.meta_to_input_Generic_Section_PID_mapping.set(pid, pid);
    });
    this.PCR_offset = target_offset ?? 0;
  }

  addMetaStream (PCR: number) {
    if (this.input_first_PCR == null) { return; }
    const input_elapsed_PCR = (PCR - this.input_first_PCR + PCR_WRAP) % PCR_WRAP + this.PCR_offset;
    while (this.meta_elapsed_PCR <= input_elapsed_PCR && !this.meta_PacketQueue.isEmpty()) {
      const packet = this.meta_PacketQueue.pop()!;

      const pid = TSPacket.pid(packet);
      if (pid === 0x00) {
        this.meta_PAT_TSSectionQueue.push(packet);
        while (!this.meta_PAT_TSSectionQueue.isEmpty()) {
          const PAT = this.meta_PAT_TSSectionQueue.pop()!;
          if (TSSection.CRC32(PAT) != 0) { continue; }

          this.meta_PMT_PID = null;
          let begin = TSSection.EXTENDED_HEADER_SIZE;
          while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PAT) - TSSection.CRC_SIZE) {
            const program_number = (PAT[begin + 0] << 8) | PAT[begin + 1];
            const program_map_PID = ((PAT[begin + 2] & 0x1F) << 8) | PAT[begin + 3];
            if (program_map_PID === 0x10) { begin += 4; continue; } // NIT

            if (this.meta_PMT_PID == null) {
              this.meta_PMT_PID = program_map_PID;
            }            

            begin += 4;
          }
        }
      } else if (pid === this.meta_PMT_PID) {
        this.meta_PMT_TSSectionQueue.push(packet);
        while (!this.meta_PMT_TSSectionQueue.isEmpty()) {
          const PMT = this.meta_PMT_TSSectionQueue.pop()!;
          if (TSSection.CRC32(PMT) != 0) { continue; }

          this.meta_PMT = PMT;

          const program_info_length = ((PMT[TSSection.EXTENDED_HEADER_SIZE + 2] & 0x0F) << 8) | PMT[TSSection.EXTENDED_HEADER_SIZE + 3];
          this.meta_PMT_PCR_PID = ((PMT[TSSection.EXTENDED_HEADER_SIZE + 0] & 0x1F) << 8) | PMT[TSSection.EXTENDED_HEADER_SIZE + 1];

          const Section_PIDS = new Map<number, number>();
          const PES_PIDS = new Map<number, number>();
          let begin = TSSection.EXTENDED_HEADER_SIZE + 4 + program_info_length;
          let pid_remains = 0x1FFE;
          while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PMT) - TSSection.CRC_SIZE) {
            const stream_type = PMT[begin + 0];
            const elementary_PID = ((PMT[begin + 1] & 0x1F) << 8) | PMT[begin + 2];
            const ES_info_length = ((PMT[begin + 3] & 0x0F) << 8) | PMT[begin + 4];

            if (stream_type !== 0x06) { continue; }
            PES_PIDS.set(elementary_PID, pid_remains--);

            begin += 5 + ES_info_length;
          }

          this.meta_to_input_PMT_Section_PID_mapping.forEach((_, pid) => {
            if (!Section_PIDS.has(pid)) {
              this.meta_to_input_PMT_Section_PID_mapping.delete(pid);
            }
          });
          Section_PIDS.forEach((_, pid) => {
            if (!this.meta_to_input_PMT_Section_PID_mapping.has(pid)) {
              this.meta_to_input_PMT_Section_PID_mapping.set(pid, Section_PIDS.get(pid)!);
            } else if(this.meta_to_input_PMT_Section_PID_mapping.get(pid) !== Section_PIDS.get(pid)!) {
              this.meta_to_input_PMT_Section_PID_mapping.set(pid, Section_PIDS.get(pid)!);
            }
          });
          this.meta_PMT_PESQueues.forEach((_, pid) => {
            if (!PES_PIDS.has(pid)) {
              this.meta_PMT_PESQueues.delete(pid);
              this.meta_to_input_PMT_PES_PID_mapping.delete(pid);
              this.meta_to_input_PMT_PES_CC.delete(pid);
            }
          });
          PES_PIDS.forEach((_, pid) => {
            if (!this.meta_PMT_PESQueues.has(pid)) {
              this.meta_PMT_PESQueues.set(pid, new TSPESQueue());
              this.meta_to_input_PMT_PES_PID_mapping.set(pid, PES_PIDS.get(pid)!);
              this.meta_to_input_PMT_PES_CC.set(pid, 0);
            }
          });
        }
      } else if (this.meta_to_input_Generic_Section_PID_mapping.has(pid)) {
        const PID = this.meta_to_input_Generic_Section_PID_mapping.get(pid)!;
        packet[1] = ((packet[1] & 0xE000) >> 8) | ((PID & 0x1F00) >> 8);
        packet[2] = PID & 0x00FF;

        this.push(packet);
      } else if (this.meta_to_input_PMT_Section_PID_mapping.has(pid)) {
        const PID = this.meta_to_input_PMT_Section_PID_mapping.get(pid)!;
        packet[1] = (packet[1] & 0xE0) | ((PID & 0x1F00) >> 8);
        packet[2] = PID & 0x00FF;

        this.push(packet);
      } else if (this.meta_to_input_PMT_PES_PID_mapping.has(pid)) {
        const pidPESQueue = this.meta_PMT_PESQueues.get(pid)!;
        while (!pidPESQueue.isEmpty()) {
          const PES = pidPESQueue.pop()!;

          const packets = TSPESPacketizer.packetize(
            PES,
            TSPacket.transport_error_indicator(packet),
            TSPacket.transport_priority(packet),
            this.meta_to_input_PMT_PES_PID_mapping.get(pid)!,
            TSPacket.transport_scrambling_control(packet),
            this.meta_to_input_PMT_PES_CC.get(pid)!,
            TSPES.has_PTS(PES) && this.meta_first_PCR != null ? (TSPES.PTS(PES)! - this.meta_first_PCR + PCR_WRAP) % PCR_WRAP : undefined,
            TSPES.has_DTS(PES) && this.meta_first_PCR != null ? (TSPES.DTS(PES)! - this.meta_first_PCR + PCR_WRAP) % PCR_WRAP : undefined
          );
          for (let i = 0; i < packets.length; i++) { this.push(packets[i]); }
          this.meta_to_input_PMT_PES_CC.set(pid, (this.meta_to_input_PMT_PES_CC.get(pid)! + packets.length) & 0x0F);
        }
      }

      if (this.meta_PMT_PCR_PID === pid) {
        if (TSPacket.has_pcr(packet)) {
          const PCR = TSPacket.pcr(packet);
          if (this.meta_first_PCR == null) { this.meta_first_PCR = PCR; }
          this.meta_elapsed_PCR = (PCR - this.meta_first_PCR + PCR_WRAP) % PCR_WRAP;
        }
      }
    }
  }

  _transform (chunk: Buffer, encoding: string, callback: TransformCallback): void {
    this.input_PacketQueue.push(chunk);
    while (!this.input_PacketQueue.isEmpty()) {
      const packet = this.input_PacketQueue.pop()!;

      const pid = TSPacket.pid(packet);
      let output = false;

      if (pid == 0x00) {
        this.input_PAT_TSSectionQueue.push(packet)
        while (!this.input_PAT_TSSectionQueue.isEmpty()) {
          const PAT = this.input_PAT_TSSectionQueue.pop()!;
          if (TSSection.CRC32(PAT) != 0) { continue; }

          this.input_PMT_PID = null;
          let begin = TSSection.EXTENDED_HEADER_SIZE;
          while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PAT) - TSSection.CRC_SIZE) {
            const program_number = (PAT[begin + 0] << 8) | PAT[begin + 1];
            const program_map_PID = ((PAT[begin + 2] & 0x1F) << 8) | PAT[begin + 3];
            if (program_map_PID === 0x10) { begin += 4; continue; } // NIT

            if (this.input_PMT_PID == null) {
              this.input_PMT_PID = program_map_PID;
            }

            begin += 4;
          }
        }
        this.push(packet);
        output = true;
      } else if (this.input_PMT_PID === pid) {
        this.input_PMT_TSSectionQueue.push(packet);
        while (!this.input_PMT_TSSectionQueue.isEmpty()) {
          const PMT = this.input_PMT_TSSectionQueue.pop()!;
          if (TSSection.CRC32(PMT) != 0) { continue; }

          const program_info_length = ((PMT[TSSection.EXTENDED_HEADER_SIZE + 2] & 0x0F) << 8) | PMT[TSSection.EXTENDED_HEADER_SIZE + 3];
          this.input_PMT_PCR_PID = ((PMT[TSSection.EXTENDED_HEADER_SIZE + 0] & 0x1F) << 8) | PMT[TSSection.EXTENDED_HEADER_SIZE + 1];

          let begin = TSSection.EXTENDED_HEADER_SIZE + 4 + program_info_length;
          let newPMT = Buffer.from(PMT.slice(0, begin))

          while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PMT) - TSSection.CRC_SIZE) {
            const stream_type = PMT[begin + 0];
            const elementary_PID = ((PMT[begin + 1] & 0x1F) << 8) | PMT[begin + 2];
            const ES_info_length = ((PMT[begin + 3] & 0x0F) << 8) | PMT[begin + 4];

            newPMT = Buffer.concat([newPMT, PMT.slice(begin, begin + 5 + ES_info_length)]);
            begin += 5 + ES_info_length;
          }
          if (this.meta_PMT != null) {
            const meta_program_info_length = ((this.meta_PMT[TSSection.EXTENDED_HEADER_SIZE + 2] & 0x0F) << 8) | this.meta_PMT[TSSection.EXTENDED_HEADER_SIZE + 3];
            for (let begin = TSSection.EXTENDED_HEADER_SIZE + 4 + meta_program_info_length; begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(this.meta_PMT) - TSSection.CRC_SIZE; ) {
              const stream_type = this.meta_PMT[begin + 0];
              let elementary_PID = ((this.meta_PMT[begin + 1] & 0x1F) << 8) | this.meta_PMT[begin + 2];
              const ES_info_length = ((this.meta_PMT[begin + 3] & 0x0F) << 8) | this.meta_PMT[begin + 4];

              if (this.meta_to_input_PMT_Section_PID_mapping.has(pid)) {
                elementary_PID = this.meta_to_input_PMT_Section_PID_mapping.get(pid)!;
              } else if (this.meta_to_input_PMT_PES_PID_mapping.has(pid)) {
                elementary_PID = this.meta_to_input_PMT_PES_PID_mapping.get(pid)!;
              } else {
                begin += 5 + ES_info_length;
                continue;
              }
              const buffer = Buffer.concat([
                Buffer.from([
                  stream_type,
                  (this.meta_PMT[begin + 1] & 0xE0) | ((elementary_PID & 0x1F00) >> 8),
                  (elementary_PID & 0x00FF),
                  (this.meta_PMT[begin + 3] & 0xF0) | ((ES_info_length & 0x0F00) >> 8),
                  (ES_info_length & 0x00FF)
                ]),
                this.meta_PMT.slice(begin + 5, begin + 5 + ES_info_length)
              ]);

              newPMT = Buffer.concat([newPMT, buffer])
              begin += 5 + ES_info_length;
            }
          }

          const newPMT_length = newPMT.length + TSSection.CRC_SIZE - TSSection.BASIC_HEADER_SIZE;
          newPMT[1] = (PMT[1] & 0xF0) | ((newPMT_length & 0x0F00) >> 8);
          newPMT[2] = (newPMT_length & 0x00FF);

          const newPMT_CRC = TSSection.CRC32(newPMT);
          newPMT = Buffer.concat([newPMT, Buffer.from([
            (newPMT_CRC & 0xFF000000) >> 24,
            (newPMT_CRC & 0x00FF0000) >> 16,
            (newPMT_CRC & 0x0000FF00) >> 8,
            (newPMT_CRC & 0x000000FF) >> 0,
          ])]);

          const packets = TSSectionPacketizer.packetize(
            newPMT,
            TSPacket.transport_error_indicator(packet),
            TSPacket.transport_priority(packet),
            pid,
            TSPacket.transport_scrambling_control(packet),
            this.input_PMT_CC
          );
          for (let i = 0; i < packets.length; i++) { this.push(packets[i]); }
          this.input_PMT_CC = (this.input_PMT_CC + packets.length) & 0x0F;
        }
        output = true;
      }

      if(this.input_PMT_PCR_PID === pid) {
        if (TSPacket.has_pcr(packet)) {
          const PCR = TSPacket.pcr(packet);
          if (this.input_first_PCR == null) { this.input_first_PCR = PCR; }
          this.addMetaStream(PCR);
        }
        
        if (!output) {
          this.push(packet);
          output = true;
        }
      }

      if (!output) {
        this.push(packet);
      }
    }
    callback();
  }

  _flush (callback: TransformCallback): void {
    callback();
  }
}
