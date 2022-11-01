#!/bin/sh

lctl set_param ldlm.namespaces.*.lru_max_age=600000
lctl set_param osc.*OST*.max_rpcs_in_flight=32
lctl set_param mdc.*.max_rpcs_in_flight=64
lctl set_param mdc.*.max_mod_rpcs_in_flight=50