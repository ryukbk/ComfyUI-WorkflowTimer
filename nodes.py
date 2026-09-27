# ComfyUI Workflow Execution Timer
# Copyright (C) 2026 Ryuichi Kubuki
#
# This program is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by the Free
# Software Foundation, either version 3 of the License, or (at your option) any
# later version.
#
# This program is distributed in the hope that it will be useful, but WITHOUT ANY
# WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
# PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License along
# with this program. If not, see <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Workflow Execution Timer - a display-only node.

Everything visible happens in web/workflow_timer.js: the node has no outputs and
nothing to compute. It exists so that

  * the user has something to place on the canvas, and
  * the node id shows up in the prompt that gets queued, which is how the frontend
    decides whether a given run belongs to *this* workflow (see the ownership notes
    in the JS).

Its inputs, full_red_minutes and font_spec, are never read here either - they are
declared so that the frontend gets widgets whose values the graph serializes and
restores. A widget added from JS alone would have to carry its own persistence. The
button that shows and hides font_spec is added from JS precisely because it is view
state and has no business in the serialized prompt.

is_output_node makes the server execute it even though nothing consumes it, and
not_idempotent stops the executor from reusing a cached result on later runs - the
node is cheap, and being executed every run keeps the two sides in step.
"""

from typing_extensions import override

from comfy_api.latest import ComfyExtension, io


class WorkflowExecutionTimer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="WorkflowExecutionTimer",
            display_name="Workflow Execution Timer",
            category="utils",
            search_aliases=["timer", "stopwatch", "execution time", "elapsed"],
            description=(
                "Shows the total execution time of this workflow as MM:SS:mmm, counting up "
                "live from the moment the run starts. The number fades from light green to "
                "red, reaching full red at the minute mark set by full_red_minutes. "
                "Underneath, a smaller line names the node currently executing and times "
                "it, and when idle the slowest node of the last run. Along the top, the "
                "previous run's total on the left and this run minus it on the right - "
                "green while ahead of that time, red once past it - with a bar along the "
                "bottom showing how far through it this run is. Runs belonging to other "
                "workflows are ignored."
            ),
            inputs=[
                io.Float.Input(
                    "full_red_minutes",
                    default=10.0,
                    min=0.1,
                    max=600.0,
                    step=0.5,
                    # the ramp is a smooth gradient, so rounding the setting would only
                    # coarsen it for no benefit
                    round=False,
                    socketless=True,
                    tooltip=(
                        "How many minutes the counter takes to fade from light green to "
                        "full red. It stays red beyond that."
                    ),
                ),
                io.String.Input(
                    "font_spec",
                    default="Oxanium:wght@400;700",
                    socketless=True,
                    tooltip=(
                        "The Google Fonts 'family=' value the node loads, e.g. "
                        "'Oxanium:wght@400;700' or 'Roboto+Mono:wght@400;700'. Spaces "
                        "become '+'. The counter asks for weight 700 and the smaller "
                        "lines for 400, so a family that carries both avoids a "
                        "synthesised fake bold. Hidden behind the settings button."
                    ),
                ),
            ],
            outputs=[],
            is_output_node=True,
            not_idempotent=True,
        )

    @classmethod
    def execute(cls, full_red_minutes: float, font_spec: str) -> io.NodeOutput:
        # both are read by the frontend off their widgets, not needed here
        del full_red_minutes, font_spec
        return io.NodeOutput()


class WorkflowTimerExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [WorkflowExecutionTimer]


async def comfy_entrypoint() -> WorkflowTimerExtension:
    return WorkflowTimerExtension()
