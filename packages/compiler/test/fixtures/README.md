# Compiler test inputs

Short MikroC programs used as inputs for the compiler tests.

`EXEMPLE1.c`, `EXEMPLE2.c`, `demux.c`, `status.c`, `int2A10.c` and `traffic2A12.c` are sample programs from the
microcontroller course this tool was built alongside. They are kept byte-for-byte, including their original
encoding and quirks, because the tests check that the compiler accepts real course code and warns about the
mistakes in it. They are not my work.

Everything else here (`*_corrige.c`, `vote.c`, `traffic.c`, `derived/`) was written for this project.
