# Recorded-audio baseline

The baseline uses the previous deployed voice build in an isolated browser with fictional memories. Recorded questions enter the microphone stream and the returned audio is captured. No questions or answers are typed into the model.

| Question | First received speech |
| --- | ---: |
| Name | 1.41 s |
| Dog | 1.96 s |
| Tea preference | 1.79 s |
| Answer-length preference | 1.83 s |

Median: **1.81 seconds**. All four turns returned audio and the expected answer text, with no delegation or waiting phrase. Time runs from the end of the recorded question's speech to the first received sound. Content uses the accompanying provider transcript; the recording was not independently transcribed. The name answer began with an affirmative word before the name, so exact time to its factual word was not separately measured.

Use the same questions, browser setup, voice, and timing method for the candidate comparison. Do not count a waiting acknowledgment as a useful answer. These four samples are a small acceptance check, not a statistical benchmark or a phone/Bluetooth test. Provider transcript timing and received-audio timing are different measurements and must not be compared as though they were the same. Raw recordings and operational logs remain private.
