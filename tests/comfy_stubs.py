import sys
import types

import numpy as np


class FakeTensor:
    def __init__(self, shape):
        self._array = np.zeros(shape, dtype=np.float32)

    @property
    def shape(self):
        return self._array.shape

    def cpu(self):
        return self

    def numpy(self):
        return self._array


def install_torch_stub():
    torch = types.ModuleType("torch")
    torch.float32 = np.float32
    torch.zeros = lambda shape, **_kwargs: FakeTensor(shape)
    sys.modules["torch"] = torch
    return torch


def install_comfy_execution_stub():
    execution = types.ModuleType("comfy_execution")
    graph_utils = types.ModuleType("comfy_execution.graph_utils")

    def is_link(value):
        return isinstance(value, (list, tuple)) and len(value) == 2

    class GraphNode:
        def __init__(self, class_type, node_id):
            self.class_type = class_type
            self.node_id = str(node_id)
            self.inputs = {}

        def set_input(self, name, value):
            self.inputs[name] = value

        def out(self, index):
            return [self.node_id, index]

    class GraphBuilder:
        def __init__(self):
            self.nodes = {}

        def node(self, class_type, node_id):
            node = GraphNode(class_type, node_id)
            self.nodes[node.node_id] = node
            return node

        def lookup_node(self, node_id):
            return self.nodes.get(str(node_id))

        def finalize(self):
            return {
                node_id: {"class_type": node.class_type, "inputs": dict(node.inputs)}
                for node_id, node in self.nodes.items()
            }

    graph_utils.GraphBuilder = GraphBuilder
    graph_utils.is_link = is_link
    execution.graph_utils = graph_utils
    sys.modules["comfy_execution"] = execution
    sys.modules["comfy_execution.graph_utils"] = graph_utils
