import { uploadLimitFor } from "@vardum/shared";
import { config } from "./config.js";

// ponytail: single-request uploads only; add multipart above these ceilings.
export const uploadLimits = {
  image: config.UPLOAD_MAX_IMAGE_MB * 1024 * 1024,
  video: config.UPLOAD_MAX_VIDEO_MB * 1024 * 1024,
  file: config.UPLOAD_MAX_FILE_MB * 1024 * 1024,
};

export const maximumUploadSize = (mimeType: string) =>
  uploadLimitFor(uploadLimits, mimeType);
