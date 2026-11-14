from typing import Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator


class BandInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class AdjustInput(BandInput):
    type: Literal["adjust"]
    delta: float = Field(ge=-1, le=1)


class StepInput(BandInput):
    type: Literal["step"]
    direction: int = Field(ge=-1, le=1, json_schema_extra={"enum": [-1, 1]})

    @field_validator("direction")
    @classmethod
    def require_direction(cls, value: int) -> int:
        if value == 0:
            raise ValueError("direction must be -1 or 1")
        return value


class ToggleInput(BandInput):
    type: Literal["toggle"]


class SelectInput(BandInput):
    type: Literal["select"]


class CommandInput(BandInput):
    type: Literal["command"]
    text: str = Field(min_length=1, max_length=4000, pattern=r"\S")


BandEvent = Union[AdjustInput, StepInput, ToggleInput, SelectInput, CommandInput]
