import warnings
import base64
import binascii
import io
import math
import os
import shutil
import tempfile
import uuid
import zlib
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .core import (
    APP_DIR, IO_CHUNK_BYTES, LOGGER, MAX_BODY_BYTES, PNG_SIGNATURE,
    ClientError, ImageRecord, oriented_image_size,
    safe_import_relative_path, torch_module, _read_save_suffix,
)
from .runtime import directml_devices, runtime_backend


def _valid_color(value: str) -> bool:
    return len(value) == 7 and value.startswith("#") and all(char in "0123456789abcdefABCDEF" for char in value[1:])


def calculate_block_size(width: int, height: int, divisor: int = 100) -> int:
    return max(4, math.ceil(max(width, height) / divisor))


def inference_device_name() -> str | None:
    torch = torch_module()
    backend = runtime_backend(torch_module=torch)
    if backend == "directml":
        devices = directml_devices()
        return str(devices[0]["name"]) if devices else None
    if backend != "cuda" or not torch.cuda.is_available():
        return None
    return torch.cuda.get_device_name(0)


def parse_png_chunks(raw: bytes) -> list[tuple[bytes, bytes]]:
    if not raw.startswith(PNG_SIGNATURE):
        raise ClientError("PNGファイルではありません。", "image_format_unsupported")
    chunks: list[tuple[bytes, bytes]] = []
    position = len(PNG_SIGNATURE)
    while position < len(raw):
        if position + 12 > len(raw):
            raise ClientError("PNGチャンクが壊れています。", "image_format_unsupported")
        length = int.from_bytes(raw[position:position + 4], "big")
        end = position + 12 + length
        if end > len(raw):
            raise ClientError("PNGチャンクが壊れています。", "image_format_unsupported")
        chunk_type = raw[position + 4:position + 8]
        chunks.append((chunk_type, raw[position:end]))
        position = end
    if not chunks or chunks[-1][0] != b"IEND":
        raise ClientError("PNG終端チャンクがありません。", "image_format_unsupported")
    return chunks


def _png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
    body = chunk_type + payload
    return len(payload).to_bytes(4, "big") + body + (zlib.crc32(body) & 0xFFFFFFFF).to_bytes(4, "big")


def _normalized_exif_bytes(source: bytes) -> bytes:
    with Image.open(io.BytesIO(source)) as source_image:
        exif = source_image.getexif()
    exif[274] = 1
    return exif.tobytes()


def _png_exif_payload(exif: bytes) -> bytes:
    return exif.removeprefix(b"Exif\x00\x00")


def _png_with_original_chunks(source: bytes, image: Image.Image, *, normalize_orientation: bool = False) -> bytes:
    source_chunks = parse_png_chunks(source)
    if any(chunk_type == b"acTL" for chunk_type, _chunk in source_chunks):
        raise ClientError("アニメーションPNGは保存対象外です。", "image_format_unsupported")
    source_ihdr = next(chunk for chunk_type, chunk in source_chunks if chunk_type == b"IHDR")

    encoded = io.BytesIO()
    image.save(encoded, format="PNG", optimize=False)
    encoded_chunks = parse_png_chunks(encoded.getvalue())
    encoded_ihdr = next(chunk for chunk_type, chunk in encoded_chunks if chunk_type == b"IHDR")
    source_ihdr_data = source_ihdr[8:-4]
    encoded_ihdr_data = encoded_ihdr[8:-4]
    if normalize_orientation:
        if source_ihdr_data[8:] != encoded_ihdr_data[8:]:
            raise ClientError("PNGの色形式またはビット深度が変化したため保存を中止しました。", "image_format_unsupported")
    elif source_ihdr_data != encoded_ihdr_data:
        raise ClientError("このPNGのカラーモードはメタデータを安全に保持して保存できません。", "image_format_unsupported")
    encoded_idat = [chunk for chunk_type, chunk in encoded_chunks if chunk_type == b"IDAT"]

    result = bytearray(PNG_SIGNATURE)
    wrote_idat = False
    normalized_exif = _png_exif_payload(_normalized_exif_bytes(source)) if normalize_orientation else None
    for chunk_type, chunk in source_chunks:
        if chunk_type == b"IHDR" and normalize_orientation:
            result.extend(encoded_ihdr)
            continue
        if chunk_type == b"eXIf" and normalized_exif is not None:
            result.extend(_png_chunk(b"eXIf", normalized_exif))
            continue
        if chunk_type == b"IDAT":
            if not wrote_idat:
                result.extend(b"".join(encoded_idat))
                wrote_idat = True
            continue
        result.extend(chunk)
    return bytes(result)


def _parse_jpeg_header(raw: bytes) -> tuple[list[tuple[int, bytes]], bytes]:
    if not raw.startswith(b"\xff\xd8"):
        raise ClientError("JPEGファイルではありません。", "image_format_unsupported")
    position = 2
    segments: list[tuple[int, bytes]] = []
    while position < len(raw):
        marker_start = position
        if raw[position] != 0xFF:
            raise ClientError("JPEGヘッダ構造を安全に解析できません。", "image_format_unsupported")
        while position < len(raw) and raw[position] == 0xFF:
            position += 1
        if position >= len(raw):
            raise ClientError("JPEGヘッダが壊れています。", "image_format_unsupported")
        marker = raw[position]
        position += 1
        if marker == 0xDA:  # Start of Scan: the remaining bytes are compressed image data.
            if position + 2 > len(raw):
                raise ClientError("JPEGスキャンヘッダが壊れています。", "image_format_unsupported")
            length = int.from_bytes(raw[position:position + 2], "big")
            if length < 2 or position + length > len(raw):
                raise ClientError("JPEGスキャンヘッダが壊れています。", "image_format_unsupported")
            return segments, raw[marker_start:]
        if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            raise ClientError("対応外のJPEGヘッダ構造です。", "image_format_unsupported")
        if position + 2 > len(raw):
            raise ClientError("JPEGヘッダが壊れています。", "image_format_unsupported")
        length = int.from_bytes(raw[position:position + 2], "big")
        end = position + length
        if length < 2 or end > len(raw):
            raise ClientError("JPEGヘッダが壊れています。", "image_format_unsupported")
        segments.append((marker, raw[marker_start:end]))
        position = end
    raise ClientError("JPEG画像データが見つかりません。", "image_format_unsupported")


def _is_jpeg_metadata_marker(marker: int) -> bool:
    return 0xE0 <= marker <= 0xEF or marker == 0xFE


def _jpeg_exif_orientation_one_segment(source: bytes) -> bytes:
    with Image.open(io.BytesIO(source)) as source_image:
        exif = source_image.getexif()
    exif[274] = 1
    payload = exif.tobytes()
    return b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload


def _expected_image_format(suffix: str) -> str:
    expected_formats = {
        ".png": "PNG",
        ".jpg": "JPEG",
        ".jpeg": "JPEG",
        ".webp": "WEBP",
    }
    try:
        return expected_formats[suffix.lower()]
    except KeyError as exc:
        raise ClientError("Unsupported image format.", "image_format_unsupported") from exc


def _assert_image_suffix_matches_format(suffix: str, image_format: str | None) -> None:
    if image_format != _expected_image_format(suffix):
        raise ClientError("The image content does not match its file extension.", "image_format_unsupported")


def inspect_import_image(path: Path, expected_suffix: str) -> tuple[int, int]:
    """Validate an input image without decoding its complete pixel payload."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                _assert_image_suffix_matches_format(expected_suffix, image.format)
                size = oriented_image_size(image)
            with Image.open(path) as image:
                image.verify()
        if expected_suffix.lower() in {".jpg", ".jpeg"}:
            with path.open("rb") as source:
                source.seek(-2, os.SEEK_END)
                if source.read() != b"\xff\xd9":
                    raise OSError("truncated JPEG")
        return size
    except (OSError, RuntimeError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ClientError("追加画像を読み込めません。", "image_read_failed") from exc


def _jpeg_with_original_metadata(source: bytes, image: Image.Image, *, normalize_orientation: bool = False) -> bytes:
    source_segments, _source_scan = _parse_jpeg_header(source)
    metadata_segments: list[tuple[int, bytes]] = []
    orientation_replaced = False
    for marker, segment in source_segments:
        if (
            normalize_orientation
            and not orientation_replaced
            and marker == 0xE1
            and segment[4:10] == b"Exif\x00\x00"
        ):
            metadata_segments.append((marker, _jpeg_exif_orientation_one_segment(source)))
            orientation_replaced = True
        elif _is_jpeg_metadata_marker(marker):
            metadata_segments.append((marker, segment))
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=95)
    encoded_segments, encoded_scan = _parse_jpeg_header(encoded.getvalue())
    output = b"\xff\xd8" + b"".join(
        segment for _marker, segment in metadata_segments
    ) + b"".join(
        segment for marker, segment in encoded_segments if not _is_jpeg_metadata_marker(marker)
    ) + encoded_scan
    return output


WEBP_METADATA_CHUNKS = {b"ICCP", b"EXIF", b"XMP "}
WEBP_SUPPORTED_CHUNKS = {b"VP8 ", b"VP8L", b"VP8X", b"ALPH", *WEBP_METADATA_CHUNKS}


def _parse_webp_chunks(raw: bytes) -> list[tuple[bytes, bytes]]:
    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
        raise ClientError("WebPファイルではありません。", "image_format_unsupported")
    if int.from_bytes(raw[4:8], "little") + 8 != len(raw):
        raise ClientError("WebPコンテナサイズを安全に検証できません。", "image_format_unsupported")
    chunks: list[tuple[bytes, bytes]] = []
    position = 12
    while position < len(raw):
        if position + 8 > len(raw):
            raise ClientError("WebPチャンクが壊れています。", "image_format_unsupported")
        chunk_type = raw[position:position + 4]
        size = int.from_bytes(raw[position + 4:position + 8], "little")
        end = position + 8 + size
        padded_end = end + (size % 2)
        if padded_end > len(raw):
            raise ClientError("WebPチャンクが壊れています。", "image_format_unsupported")
        chunks.append((chunk_type, raw[position:padded_end]))
        position = padded_end
    return chunks


def _validate_safe_webp_structure(raw: bytes) -> None:
    chunks = _parse_webp_chunks(raw)
    chunk_types = [chunk_type for chunk_type, _chunk in chunks]
    if any(chunk_type in {b"ANIM", b"ANMF"} for chunk_type in chunk_types):
        raise ClientError("アニメーションWebPは安全保証できないため保存対象外です。", "image_format_unsupported")
    if any(chunk_type not in WEBP_SUPPORTED_CHUNKS for chunk_type in chunk_types):
        raise ClientError("対応外のWebPチャンクがあるため保存を中止しました。", "image_format_unsupported")
    if sum(chunk_type in {b"VP8 ", b"VP8L"} for chunk_type in chunk_types) != 1:
        raise ClientError("WebP画像データを安全に検証できません。", "image_format_unsupported")


def _webp_with_original_metadata(
    source: bytes, image: Image.Image, source_info: dict[str, Any], *, normalize_orientation: bool = False,
) -> bytes:
    _validate_safe_webp_structure(source)
    save_args = {
        key: source_info[key]
        for key in ("icc_profile", "exif", "xmp")
        if key in source_info
    }
    if normalize_orientation:
        save_args["exif"] = _normalized_exif_bytes(source)
    encoded = io.BytesIO()
    image.save(encoded, format="WEBP", quality=95, **save_args)
    output = encoded.getvalue()
    return output


def _apply_mosaic_to_image(image: Image.Image, mask: np.ndarray, block_size: int) -> Image.Image:
    if block_size < 1:
        raise ClientError("モザイク粗さが正しくありません。", "input_invalid")
    original_mode = image.mode
    if original_mode not in {"RGB", "RGBA", "L"}:
        raise ClientError("この画像モードは安全保存に対応していません。", "image_format_unsupported")
    image_array = np.asarray(image)
    if mask.shape != image_array.shape[:2]:
        raise ClientError("マスクと画像サイズが一致しません。", "input_invalid")
    width, height = image.size

    # Calculate each block from pixels that will actually receive mosaic.  This
    # intentionally excludes nearby excluded/unselected pixels from the colour
    # average, so the editor preview and saved image do not bleed across masks.
    #
    # Work one block-row at a time.  The former whole-image block-id grid and
    # int64 RGB copy were both several times larger than a 4K source image.
    # Keeping only a block-row is bit-for-bit equivalent: a mosaic block never
    # crosses either its horizontal or vertical block boundary.
    x_starts = np.arange(0, width, block_size)
    x_widths = np.diff(np.append(x_starts, width))
    output = image_array.copy()

    for top in range(0, height, block_size):
        bottom = min(height, top + block_size)
        source_rows = image_array[top:bottom]
        selected = mask[top:bottom] > 0
        # First collapse the block-row vertically, then horizontally.  The
        # calculations stay in int64 just like the former bincount path.
        selected_columns = selected.sum(axis=0, dtype=np.int64)
        counts = np.add.reduceat(selected_columns, x_starts)

        if original_mode == "RGBA":
            alpha = source_rows[..., 3].astype(np.int64, copy=False)
            weights = alpha * selected
            alpha_columns = weights.sum(axis=0, dtype=np.int64)
            alpha_sums = np.add.reduceat(alpha_columns, x_starts)
            alpha_valid = alpha_sums > 0
            colors = np.zeros((len(x_starts), 3), dtype=np.uint8)
            rgb = source_rows[..., :3].astype(np.int64, copy=False)
            for channel in range(3):
                channel_columns = (rgb[..., channel] * weights).sum(axis=0, dtype=np.int64)
                sums = np.add.reduceat(channel_columns, x_starts)
                colors[alpha_valid, channel] = (
                    (sums[alpha_valid] + alpha_sums[alpha_valid] // 2) // alpha_sums[alpha_valid]
                ).astype(np.uint8)
            per_column = np.repeat(colors, x_widths, axis=0)
            apply = selected & np.repeat(alpha_valid, x_widths)[None, :]
            output_rows = output[top:bottom, :, :3]
            output_rows[apply] = np.broadcast_to(per_column, output_rows.shape)[apply]
            continue

        valid = counts > 0
        if original_mode == "L":
            values = source_rows.astype(np.int64, copy=False)
            column_sums = (values * selected).sum(axis=0, dtype=np.int64)
            sums = np.add.reduceat(column_sums, x_starts)
            colors = np.zeros(len(x_starts), dtype=np.uint8)
            colors[valid] = ((sums[valid] + counts[valid] // 2) // counts[valid]).astype(np.uint8)
            output_rows = output[top:bottom]
            output_rows[selected] = np.broadcast_to(np.repeat(colors, x_widths), output_rows.shape)[selected]
            continue

        values = source_rows.astype(np.int64, copy=False)
        colors = np.zeros((len(x_starts), 3), dtype=np.uint8)
        for channel in range(3):
            column_sums = (values[..., channel] * selected).sum(axis=0, dtype=np.int64)
            sums = np.add.reduceat(column_sums, x_starts)
            colors[valid, channel] = ((sums[valid] + counts[valid] // 2) // counts[valid]).astype(np.uint8)
        output_rows = output[top:bottom]
        output_rows[selected] = np.broadcast_to(np.repeat(colors, x_widths, axis=0), output_rows.shape)[selected]

    return Image.fromarray(output)


def _decode_mask(data_url: str, width: int, height: int) -> np.ndarray:
    if not isinstance(data_url, str) or not data_url.startswith("data:image/png;base64,"):
        raise ClientError("PNG形式の編集マスクが必要です。", "input_invalid")
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    except (IndexError, binascii.Error) as exc:
        raise ClientError("編集マスクを読み込めません。", "input_invalid") from exc
    if len(raw) > MAX_BODY_BYTES:
        raise ClientError("編集マスクが大きすぎます。", "input_invalid")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG":
                raise ClientError("The mask must be a PNG image.", "input_invalid")
            if image.size != (width, height):
                raise ClientError("編集マスクのサイズが元画像と一致しません。", "input_invalid")
            if image.mode in {"RGBA", "LA"}:
                return np.asarray(image.getchannel("A"), dtype=np.uint8)
            if image.mode in {"L", "1"}:
                return np.asarray(image.convert("L"), dtype=np.uint8)
            raise ClientError("The mask must include an alpha channel or be grayscale.", "input_invalid")
    except (OSError, UnidentifiedImageError) as exc:
        raise ClientError("編集マスクは有効なPNGではありません。", "input_invalid") from exc


def decode_draft_masks(raw_draft: Any, width: int, height: int) -> tuple[np.ndarray | None, np.ndarray | None, np.ndarray | None]:
    if raw_draft is None:
        return None, None, None
    if not isinstance(raw_draft, dict):
        raise ClientError("手描きマスクの形式が正しくありません。", "input_invalid")
    add = raw_draft.get("add") if raw_draft.get("manualEnabled", True) is not False else None
    exclusion = raw_draft.get("exclusion") if raw_draft.get("manualExclusionEnabled", True) is not False else None
    exclusion_erase = raw_draft.get("exclusionErase") if raw_draft.get("manualExclusionEraseEnabled", True) is not False else None
    return (
        _decode_mask(str(add), width, height) if add else None,
        _decode_mask(str(exclusion), width, height) if exclusion else None,
        _decode_mask(str(exclusion_erase), width, height) if exclusion_erase else None,
    )


def draft_manual_exclusion_forced(raw_draft: Any, default: bool = True) -> bool:
    """Use the configured default for drafts created before per-exclusion state existed."""
    if not isinstance(raw_draft, dict):
        return default
    return raw_draft.get("manualExclusionForced", default) is not False


def unique_session_import_destination(path: Path, reserved: set[Path] | None = None) -> Path:
    reserved = reserved if reserved is not None else set()
    if not path.exists() and path not in reserved:
        return path
    for number in range(2, 10000):
        candidate = path.with_name(f"{path.stem}_{number}{path.suffix}")
        if not candidate.exists() and candidate not in reserved:
            return candidate
    raise ClientError("同名ファイルが多すぎるため保存先を決められません。", "save_write_failed")


def _default_output_destination(record: ImageRecord, suffix: str = "_censored", reserved: set[Path] | None = None) -> Path:
    relative = safe_import_relative_path(record.relative_path)
    target = APP_DIR / "output" / relative
    return unique_session_import_destination(target.with_name(f"{target.stem}{_read_save_suffix(suffix)}{target.suffix}"), reserved)


def _source_stat_fingerprint(path: Path) -> tuple[int, int]:
    try:
        stat = path.stat()
    except OSError as exc:
        raise ClientError("元画像が外部で変更または削除されました。画像を再読み込みしてください。", "stale_asset") from exc
    return stat.st_mtime_ns, stat.st_size


def _assert_source_stat_matches(record: ImageRecord, expected: tuple[int, int] | None = None) -> None:
    if _source_stat_fingerprint(record.path) != (expected or record.asset_fingerprint()):
        raise ClientError("元画像が外部で変更されました。画像を再読み込みしてください。", "stale_asset")


def render_with_mask(record: ImageRecord, mask: np.ndarray, block_size: int) -> bytes:
    """Render one image without changing the source file or its catalogue state."""
    source = record.path.read_bytes()
    _assert_source_stat_matches(record)
    suffix = record.path.suffix.lower()
    with Image.open(io.BytesIO(source)) as source_image:
        source_image.load()
        normalize_orientation = source_image.getexif().get(274, 1) not in {None, 1}
        normalized = ImageOps.exif_transpose(source_image)
        modified = _apply_mosaic_to_image(normalized, mask, block_size)
        if suffix == ".png":
            return _png_with_original_chunks(source, modified, normalize_orientation=normalize_orientation)
        if suffix in {".jpg", ".jpeg"}:
            return _jpeg_with_original_metadata(source, modified, normalize_orientation=normalize_orientation)
        if suffix == ".webp":
            return _webp_with_original_metadata(source, modified, source_image.info, normalize_orientation=normalize_orientation)
    raise ClientError("この画像形式は保存に対応していません。", "image_format_unsupported")


class SourceReplaceStage:
    def __init__(self, record: ImageRecord, backup_path: Path) -> None:
        self.record = record
        self.backup_path = backup_path

    def rollback(self) -> None:
        if self.backup_path.exists():
            os.replace(self.backup_path, self.record.path)
            _sync_directory(self.record.path.parent)

    def finalize(self) -> None:
        self.backup_path.unlink(missing_ok=True)
        _sync_directory(self.record.path.parent)


def _sync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _remove_incomplete_backup(backup_path: Path) -> None:
    """Do not leave a rollback file behind when the replacement never happened."""
    try:
        backup_path.unlink(missing_ok=True)
    except OSError:
        LOGGER.warning("Incomplete save backup could not be removed: %s", backup_path)


def _stage_record_replacement(record: ImageRecord, rendered_path: Path, expected_source_fingerprint: tuple[int, int]) -> SourceReplaceStage:
    """Replace a source while retaining a same-directory rollback copy."""
    original_stat = record.path.stat()
    temporary_path: Path | None = None
    backup_path = record.path.with_name(f".{record.path.name}.mozarie-backup-{uuid.uuid4().hex}")
    try:
        with tempfile.NamedTemporaryFile(dir=record.path.parent, suffix=f"{record.path.suffix}.mozarie.tmp", delete=False) as handle:
            temporary_path = Path(handle.name)
            with rendered_path.open("rb") as rendered:
                while chunk := rendered.read(IO_CHUNK_BYTES):
                    handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        _assert_source_stat_matches(record, expected_source_fingerprint)
        replaced = False
        try:
            shutil.copy2(record.path, backup_path)
            _assert_source_stat_matches(record, expected_source_fingerprint)
            os.replace(temporary_path, record.path)
            replaced = True
        finally:
            if not replaced:
                _remove_incomplete_backup(backup_path)
        temporary_path = None
        _sync_directory(record.path.parent)
        if record.source_kind == "filesystem":
            try:
                os.utime(record.path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
            except OSError:
                LOGGER.warning("Saved image timestamp could not be restored: %s", record.path)
        stat = record.path.stat()
        record.set_asset_fingerprint(stat.st_mtime_ns, stat.st_size)
        if record.source_kind == "filesystem":
            record.mtime_ns = stat.st_mtime_ns
            record.size_bytes = stat.st_size
        return SourceReplaceStage(record, backup_path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _replace_record_with_rendered_output(record: ImageRecord, rendered_path: Path, expected_source_fingerprint: tuple[int, int]) -> None:
    """Atomically replace a catalogued source and finalize it immediately."""
    _stage_record_replacement(record, rendered_path, expected_source_fingerprint).finalize()


def write_rendered_copy(destination: Path, output: bytes) -> None:
    """Write a default-output copy without exposing a partial image."""
    temporary_path: Path | None = None
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=f"{destination.suffix}.mozarie.tmp", delete=False) as handle:
            temporary_path = Path(handle.name)
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def save_with_mask(record: ImageRecord, mask: np.ndarray, block_size: int) -> None:
    _stage_save_with_mask(record, mask, block_size).finalize()


def _stage_save_with_mask(record: ImageRecord, mask: np.ndarray, block_size: int) -> SourceReplaceStage:
    destination = record.path
    original_stat = record.path.stat()
    output = render_with_mask(record, mask, block_size)
    temporary_path: Path | None = None
    backup_path = destination.with_name(f".{destination.name}.mozarie-backup-{uuid.uuid4().hex}")
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=f"{destination.suffix}.mozarie.tmp", delete=False) as handle:
            temporary_path = Path(handle.name)
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        _assert_source_stat_matches(record)
        replaced = False
        try:
            shutil.copy2(destination, backup_path)
            _assert_source_stat_matches(record)
            os.replace(temporary_path, destination)
            replaced = True
        finally:
            if not replaced:
                _remove_incomplete_backup(backup_path)
        temporary_path = None
        _sync_directory(destination.parent)
        try:
            os.utime(destination, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        except OSError:
            LOGGER.warning("Saved image timestamp could not be restored: %s", destination)
        stat = destination.stat()
        record.set_asset_fingerprint(stat.st_mtime_ns, stat.st_size)
        if record.source_kind == "filesystem":
            record.mtime_ns = stat.st_mtime_ns
            record.size_bytes = stat.st_size
        return SourceReplaceStage(record, backup_path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
