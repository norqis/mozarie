"""Output basenames for a batch, in the user's selected catalogue order."""
from .core import ClientError, output_relative_path


def numbered_filenames(records, numbering, output_format="original"):
    if numbering is None:
        return {}
    if (not isinstance(numbering, dict) or type(numbering.get("digits")) is not int
            or numbering["digits"] not in range(2, 6)
            or numbering.get("placement") not in {"only", "prefix", "suffix"}):
        raise ClientError("連番の設定が正しくありません。", "input_invalid")
    digits = numbering["digits"]
    if len(records) >= 10 ** digits:
        raise ClientError("指定桁数では保存できません。", "numbering_limit" if len(records) >= 100000 else "numbering_overflow",
                          {"count": len(records), "digits": digits, "required": len(str(len(records)))})
    names = {}
    for index, record in enumerate(records, 1):
        original = output_relative_path(record)
        extension = original.suffix if output_format == "original" else f".{output_format}"
        number = str(index).zfill(digits)
        stem = number if numbering["placement"] == "only" else (
            f"{number}_{original.stem}" if numbering["placement"] == "prefix" else f"{original.stem}_{number}")
        names[record.image_id] = f"{stem}{extension}"
    return names
