import unittest

from bodyos_mac.window_geometry import (
    Display,
    Rect,
    adjacent_display,
    display_for_window,
    target_frame,
)


def _side_by_side() -> list[Display]:
    # Primary display at origin, a second display immediately to its right.
    return [
        Display(index=0, bounds=Rect(0, 0, 1440, 900), is_main=True),
        Display(index=1, bounds=Rect(1440, 0, 1920, 1080)),
    ]


class DisplayForWindowTests(unittest.TestCase):
    def test_picks_display_with_greatest_overlap(self) -> None:
        displays = _side_by_side()
        window = Rect(100, 100, 400, 300)  # fully on display 0
        self.assertEqual(display_for_window(displays, window).index, 0)

    def test_window_mostly_on_second_display(self) -> None:
        displays = _side_by_side()
        window = Rect(1500, 200, 400, 300)  # fully on display 1
        self.assertEqual(display_for_window(displays, window).index, 1)

    def test_straddling_window_uses_larger_overlap(self) -> None:
        displays = _side_by_side()
        # Mostly on display 1: 340 px on the right, 60 px on the left.
        window = Rect(1380, 100, 400, 300)
        self.assertEqual(display_for_window(displays, window).index, 1)

    def test_off_screen_window_falls_back_to_nearest_center(self) -> None:
        displays = _side_by_side()
        window = Rect(-500, -500, 100, 100)
        self.assertEqual(display_for_window(displays, window).index, 0)


class AdjacentDisplayTests(unittest.TestCase):
    def test_right_neighbour(self) -> None:
        displays = _side_by_side()
        source = displays[0]
        neighbour = adjacent_display(displays, source, direction=1)
        self.assertIsNotNone(neighbour)
        self.assertEqual(neighbour.index, 1)

    def test_left_neighbour(self) -> None:
        displays = _side_by_side()
        source = displays[1]
        neighbour = adjacent_display(displays, source, direction=-1)
        self.assertIsNotNone(neighbour)
        self.assertEqual(neighbour.index, 0)

    def test_no_display_in_direction(self) -> None:
        displays = _side_by_side()
        # Nothing is to the left of the primary display.
        self.assertIsNone(adjacent_display(displays, displays[0], direction=-1))
        # Nothing is to the right of the rightmost display.
        self.assertIsNone(adjacent_display(displays, displays[1], direction=1))

    def test_single_display_has_no_neighbour(self) -> None:
        displays = [Display(index=0, bounds=Rect(0, 0, 1440, 900), is_main=True)]
        self.assertIsNone(adjacent_display(displays, displays[0], direction=1))
        self.assertIsNone(adjacent_display(displays, displays[0], direction=-1))

    def test_prefers_vertically_overlapping_neighbour(self) -> None:
        # Two candidates to the right: one stacked above (no vertical overlap),
        # one level with the source. The level one should win.
        displays = [
            Display(index=0, bounds=Rect(0, 0, 1000, 1000), is_main=True),
            Display(index=1, bounds=Rect(1000, -2000, 1000, 1000)),  # above, no overlap
            Display(index=2, bounds=Rect(1000, 0, 1000, 1000)),  # level
        ]
        neighbour = adjacent_display(displays, displays[0], direction=1)
        self.assertEqual(neighbour.index, 2)

    def test_display_stacked_above_and_offset_is_not_a_side_neighbour(self) -> None:
        displays = [
            Display(index=0, bounds=Rect(0, 0, 1000, 1000), is_main=True),
            Display(index=1, bounds=Rect(-200, -1000, 1000, 1000)),  # above, nudged left
        ]
        self.assertIsNone(adjacent_display(displays, displays[0], direction=-1))
        self.assertIsNone(adjacent_display(displays, displays[1], direction=1))


class TargetFrameTests(unittest.TestCase):
    def test_preserves_share_of_free_room(self) -> None:
        displays = _side_by_side()
        source, target = displays[0], displays[1]
        # Window 20% of the way across / 10% of the way down the room it has.
        window = Rect(0.2 * (1440 - 400), 0.1 * (900 - 300), 400, 300)
        result = target_frame(window, source, target)
        self.assertAlmostEqual(result.x, 1440 + 0.2 * (1920 - 400), places=3)
        self.assertAlmostEqual(result.y, 0.1 * (1080 - 300), places=3)
        self.assertEqual(result.width, 400)
        self.assertEqual(result.height, 300)

    def test_there_and_back_returns_to_the_start(self) -> None:
        large = Display(index=0, bounds=Rect(0, 0, 1470, 956), is_main=True, visible=Rect(0, 33, 1470, 923))
        small = Display(index=1, bounds=Rect(1470, 112, 1164, 802))
        window = Rect(619, 205, 757, 686)
        there = target_frame(window, large, small)
        back = target_frame(there, small, large)
        for got, want in zip((back.x, back.y, back.width, back.height), (619, 205, 757, 686)):
            self.assertAlmostEqual(got, want, places=6)

    def test_clamps_so_window_stays_fully_on_target(self) -> None:
        displays = [
            Display(index=0, bounds=Rect(0, 0, 1000, 1000), is_main=True),
            Display(index=1, bounds=Rect(1000, 0, 800, 600)),  # smaller target
        ]
        source, target = displays[0], displays[1]
        window = Rect(900, 900, 400, 300)  # near bottom-right of source
        result = target_frame(window, source, target)
        self.assertLessEqual(result.x + result.width, target.bounds.max_x + 1e-6)
        self.assertLessEqual(result.y + result.height, target.bounds.max_y + 1e-6)
        self.assertGreaterEqual(result.x, target.bounds.x - 1e-6)
        self.assertGreaterEqual(result.y, target.bounds.y - 1e-6)

    def test_shrinks_window_larger_than_target(self) -> None:
        displays = [
            Display(index=0, bounds=Rect(0, 0, 2000, 2000), is_main=True),
            Display(index=1, bounds=Rect(2000, 0, 800, 600)),
        ]
        source, target = displays[0], displays[1]
        window = Rect(100, 100, 1500, 1200)  # bigger than target display
        result = target_frame(window, source, target)
        self.assertLessEqual(result.width, 800)
        self.assertLessEqual(result.height, 600)
        self.assertGreaterEqual(result.x, target.bounds.x - 1e-6)
        self.assertGreaterEqual(result.y, target.bounds.y - 1e-6)

    def test_lands_clear_of_menu_bar_and_dock(self) -> None:
        source = Display(index=0, bounds=Rect(0, 0, 1000, 1000), is_main=True)
        target = Display(
            index=1, bounds=Rect(1000, 0, 800, 600), visible=Rect(1000, 25, 800, 500),
        )
        result = target_frame(Rect(0, 0, 900, 900), source, target)
        self.assertEqual(result, Rect(1000, 25, 800, 500))

    def test_asks_for_a_given_size_when_it_fits(self) -> None:
        small = Display(index=0, bounds=Rect(0, 0, 800, 600), is_main=True)
        large = Display(index=1, bounds=Rect(800, 0, 2000, 2000))
        result = target_frame(Rect(0, 0, 800, 600), small, large, size=Rect(0, 0, 1500, 1200))
        self.assertEqual((result.width, result.height), (1500, 1200))


if __name__ == "__main__":
    unittest.main()
